//! Process-level resource metrics, sampled without any external dependency.
//!
//! Everything here goes through plain `extern "system"` calls into kernel32 /
//! psapi, so the worker stays a single self-contained binary — no `windows-sys`,
//! no build step that needs a C compiler. Windows is the only supported host for
//! now; on other platforms `available()` reports false and callers omit the block.
//!
//! 职责：采集当前 worker 进程的 CPU 百分比（按单核归一）、工作集与私有字节、
//! 句柄数，供 `metrics.sample` 与宿主 MetricsStore 使用。
//! 不变量：
//! - 采样是只读的，除 CPU 基线（见 `cpu_share` 中的两个原子量）外不修改任何状态；
//! - 任何 Win32 调用失败都降级为 0 / false，绝不 panic；
//! - 单位约定：内存与 IO 计数一律 bytes，CPU 是 0–100 的单核百分比（多核可超过 100）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
mod imp {
    /// 对应 Win32 的 PROCESS_MEMORY_COUNTERS：字段顺序与宽度必须与 psapi 一致，
    /// 不可重排。`cb` 由调用方填成结构体字节大小，填错会让 GetProcessMemoryInfo 失败。
    /// 其中 `pagefile_usage` 即提交的私有字节，上报为 privateBytes。
    #[repr(C)]
    struct ProcessMemoryCounters {
        cb: u32,
        page_fault_count: u32,
        peak_working_set_size: usize,
        working_set_size: usize,
        quota_peak_paged_pool_usage: usize,
        quota_paged_pool_usage: usize,
        quota_peak_non_paged_pool_usage: usize,
        quota_non_paged_pool_usage: usize,
        pagefile_usage: usize,
        peak_pagefile_usage: usize,
    }

    /// 对应 Win32 的 IO_COUNTERS：6 个 u64 累加计数器，操作数与字节数分列。
    /// 同样是 FFI 布局，顺序与类型不可改动。
    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    /// Win32 FILETIME：两个 32 位半字拼成的 64 位计数，单位 100ns，
    /// 表示自 1601-01-01 起的绝对时间量。这里只当作差值使用。
    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    impl FileTime {
        /// 把低/高两个 u32 合成 u64 的 100ns 计数；先转 u64 再移位，避免 u32 溢出。
        fn as_u64(&self) -> u64 {
            ((self.high as u64) << 32) | self.low as u64
        }
    }

    // kernel32 的进程信息导入。这些声明本身不校验参数：
    // 调用方必须传入有效且已对齐的输出缓冲区（这里都是栈上变量），
    // 返回 0 表示失败，此时缓冲区内容不可信，只能按 0 处理。
    // GetCurrentProcess 返回的是伪句柄（-1），无需也不会被关闭。
    extern "system" {
        fn GetCurrentProcess() -> *mut std::ffi::c_void;
        fn GetProcessIoCounters(process: *mut std::ffi::c_void, counters: *mut IoCounters) -> i32;
        fn GetProcessHandleCount(process: *mut std::ffi::c_void, count: *mut u32) -> i32;
        fn GetProcessTimes(
            process: *mut std::ffi::c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn GetSystemInfo(info: *mut SystemInfo);
    }

    // psapi.dll, not kernel32: the gnu target links kernel32 by default only.
    // 因此用 #[link] 单独指定 psapi，避免在 gnu target 上产生未解析符号。
    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut std::ffi::c_void,
            counters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
    }

    /// 对应 Win32 的 SYSTEM_INFO。本模块只读取 `number_of_processors`，
    /// 其余字段必须按原布局保留，否则后续字段会错位。
    #[repr(C)]
    struct SystemInfo {
        architecture: u16,
        reserved: u16,
        page_size: u32,
        minimum_application_address: *mut std::ffi::c_void,
        maximum_application_address: *mut std::ffi::c_void,
        active_processor_mask: usize,
        number_of_processors: u32,
        processor_type: u32,
        allocation_granularity: u32,
        processor_level: u16,
        processor_revision: u16,
    }

    /// Windows 采样实现：一次性读取内存、IO、句柄、CPU 时间与处理器数，
    /// 逐项独立降级，最后拼成统一的 metrics JSON。返回值为纯数据，不会 panic。
    pub fn sample() -> serde_json::Value {
        let process = unsafe { GetCurrentProcess() };

        let mut memory = ProcessMemoryCounters {
            cb: std::mem::size_of::<ProcessMemoryCounters>() as u32,
            page_fault_count: 0,
            peak_working_set_size: 0,
            working_set_size: 0,
            quota_peak_paged_pool_usage: 0,
            quota_paged_pool_usage: 0,
            quota_peak_non_paged_pool_usage: 0,
            quota_non_paged_pool_usage: 0,
            pagefile_usage: 0,
            peak_pagefile_usage: 0,
        };
        // 各项采集互不影响：某一项失败只把对应字段降级为 0/false，其余照常上报。
        let memory_ok = unsafe { GetProcessMemoryInfo(process, &mut memory, memory.cb) } != 0;

        let mut io = IoCounters {
            read_operation_count: 0,
            write_operation_count: 0,
            other_operation_count: 0,
            read_transfer_count: 0,
            write_transfer_count: 0,
            other_transfer_count: 0,
        };
        let io_ok = unsafe { GetProcessIoCounters(process, &mut io) } != 0;

        let mut handles: u32 = 0;
        let handles_ok = unsafe { GetProcessHandleCount(process, &mut handles) } != 0;

        let mut cpu_ms: u64 = 0;
        let (mut creation, mut exit, mut kernel, mut user) = (
            FileTime { low: 0, high: 0 },
            FileTime { low: 0, high: 0 },
            FileTime { low: 0, high: 0 },
            FileTime { low: 0, high: 0 },
        );
        if unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) } != 0
        {
            // FILETIME is 100 ns ticks; kernel + user covers the whole process.
            // FILETIME 以 100ns 为一 tick，除以 10_000 换算成毫秒；
            // kernel + user 即整进程累计 CPU 时间，creation/exit 在此不使用。
            cpu_ms = (kernel.as_u64() + user.as_u64()) / 10_000;
        }

        let mut sysinfo = SystemInfo {
            architecture: 0,
            reserved: 0,
            page_size: 0,
            minimum_application_address: std::ptr::null_mut(),
            maximum_application_address: std::ptr::null_mut(),
            active_processor_mask: 0,
            number_of_processors: 0,
            processor_type: 0,
            allocation_granularity: 0,
            processor_level: 0,
            processor_revision: 0,
        };
        // GetSystemInfo 返回 void，调用后即认为已填充；失败也无从判断，故不设 ok 标志。
        unsafe { GetSystemInfo(&mut sysinfo) };

        // 采样窗口：mono 是进程启动以来的单调毫秒数，cpu_share 用它和上一次采样求差，
        // 从而把累计 CPU 时间换算成这段时间内的平均单核占用。
        let mono = super::mono_ms();
        let cpu_share = super::cpu_share(cpu_ms, mono);

        // 输出单位约定：内存与 IO 字段为 bytes，uptimeMs / cpuMsTotal 为毫秒，
        // cpuPctOneCore 为单核百分比；采集失败的项以 0 或 available=false 表示。
        serde_json::json!({
            "schema": "dsh-rust-exec/worker-metrics@1",
            "sampledAtMs": super::now_wall_ms(),
            "pid": std::process::id(),
            "uptimeMs": mono,
            "processors": sysinfo.number_of_processors,
            "memory": {
                "workingSetBytes": if memory_ok { memory.working_set_size as u64 } else { 0 },
                "privateBytes": if memory_ok { memory.pagefile_usage as u64 } else { 0 },
                "peakWorkingSetBytes": if memory_ok { memory.peak_working_set_size as u64 } else { 0 },
                "pageFaults": if memory_ok { memory.page_fault_count as u64 } else { 0 },
                "available": memory_ok,
            },
            "cpu": {
                "cpuMsTotal": cpu_ms,
                // percent of ONE core; with lanes in flight this can exceed 100
                "cpuPctOneCore": cpu_share,
            },
            "handles": if handles_ok { handles as u64 } else { 0 },
            "io": {
                "readOps": io.read_operation_count,
                "writeOps": io.write_operation_count,
                "otherOps": io.other_operation_count,
                "readBytes": io.read_transfer_count,
                "writeBytes": io.write_transfer_count,
                "otherBytes": io.other_transfer_count,
                "available": io_ok,
            },
        })
    }
}

/// 上一次采样到的 CPU 累计毫秒数与对应的单调时钟毫秒数，作为计算增量的基线。
/// 初值 0 表示尚未采样，cpu_share 会据此跳过第一次计算。
static LAST_CPU: AtomicU64 = AtomicU64::new(0);
static LAST_MONO: AtomicU64 = AtomicU64::new(0);

/// 进程启动以来的单调毫秒数（首次调用时以 START 的初始化为起点）。
fn mono_ms() -> u64 {
    let mono = START.get_or_init(Instant::now).elapsed().as_millis() as u64;
    mono
}

/// 当前墙钟时间的 Unix 毫秒数；系统时间早于 epoch 或被回拨时降级为 0。
pub(crate) fn now_wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 两次采样之间的 CPU 占用率，按单核百分比表示。
/// 计算方式：Δcpu / Δmono，因此结果与采样间隔无关；单核满载为 100。
/// CPU utilisation between two samples, expressed as percent of one core.
/// A worker running N lanes in parallel legitimately reports up to N*100.
fn cpu_share(cpu_ms: u64, mono_ms: u64) -> f64 {
    // swap 原子地把本次值换成基线，同时取回上一次的值；两者成对更新，避免撕裂。
    let prev_cpu = LAST_CPU.swap(cpu_ms, Ordering::SeqCst);
    let prev_mono = LAST_MONO.swap(mono_ms, Ordering::SeqCst);
    // 首次采样（基线为 0）、时钟未前进或计数器回退时无法做差，直接给 0 而不是 panic。
    if prev_cpu == 0 || prev_mono == 0 || mono_ms <= prev_mono || cpu_ms < prev_cpu {
        return 0.0;
    }
    let cpu_delta = (cpu_ms - prev_cpu) as f64;
    let mono_delta = (mono_ms - prev_mono) as f64;
    // 归一：Δcpu 毫秒数占墙钟毫秒数的比例，乘 100 得到百分比。
    (cpu_delta / mono_delta) * 100.0
}

/// 单调时钟起点，进程内首次采样时初始化；之后所有 mono_ms 都相对它。
static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// 当前平台是否支持真正的采样；非 Windows 上调用方会省略 metrics 块。
pub fn available() -> bool {
    cfg!(windows)
}

/// 对外采样入口：Windows 下取真实数据，其余平台返回 available=false 的降级 JSON，
/// 再统一并入队列（lane 池）与索引状态后返回。
pub fn sample(pool: &crate::LanePool) -> serde_json::Value {
    // 编译期分支：只有 Windows 会链接上面的 imp 模块，其他平台走静态降级值。
    #[cfg(windows)]
    let mut value = imp::sample();
    #[cfg(not(windows))]
    let mut value = serde_json::json!({
        "schema": "dsh-rust-exec/worker-metrics@1",
        "available": false,
        "reason": "unsupported platform",
    });

    // 仅当负载是 JSON 对象时才合并，保证非 Windows 的降级对象也带上队列信息。
    if let serde_json::Value::Object(map) = &mut value {
        map.insert(
            "queue".to_string(),
            serde_json::json!({
                "lanes": pool.len(),
                "queued": pool.queued(),
                "peakQueued": pool.peak_queued(),
                "rejected": pool.rejected(),
                "inflight": crate::inflight(),
            }),
        );
        map.insert("index".to_string(), crate::index::status_value());
    }
    value
}

