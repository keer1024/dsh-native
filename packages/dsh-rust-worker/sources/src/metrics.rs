//! Process-level resource metrics, sampled without any external dependency.
//!
//! Everything here goes through plain `extern "system"` calls into kernel32 /
//! psapi, so the worker stays a single self-contained binary — no `windows-sys`,
//! no build step that needs a C compiler. Windows is the only supported host for
//! now; on other platforms `available()` reports false and callers omit the block.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
mod imp {
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

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    impl FileTime {
        fn as_u64(&self) -> u64 {
            ((self.high as u64) << 32) | self.low as u64
        }
    }

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
    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut std::ffi::c_void,
            counters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
    }

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
        unsafe { GetSystemInfo(&mut sysinfo) };

        let mono = super::mono_ms();
        let cpu_share = super::cpu_share(cpu_ms, mono);

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

static LAST_CPU: AtomicU64 = AtomicU64::new(0);
static LAST_MONO: AtomicU64 = AtomicU64::new(0);

fn mono_ms() -> u64 {
    let mono = START.get_or_init(Instant::now).elapsed().as_millis() as u64;
    mono
}

pub(crate) fn now_wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// CPU utilisation between two samples, expressed as percent of one core.
/// A worker running N lanes in parallel legitimately reports up to N*100.
fn cpu_share(cpu_ms: u64, mono_ms: u64) -> f64 {
    let prev_cpu = LAST_CPU.swap(cpu_ms, Ordering::SeqCst);
    let prev_mono = LAST_MONO.swap(mono_ms, Ordering::SeqCst);
    if prev_cpu == 0 || prev_mono == 0 || mono_ms <= prev_mono || cpu_ms < prev_cpu {
        return 0.0;
    }
    let cpu_delta = (cpu_ms - prev_cpu) as f64;
    let mono_delta = (mono_ms - prev_mono) as f64;
    (cpu_delta / mono_delta) * 100.0
}

static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

pub fn available() -> bool {
    cfg!(windows)
}

pub fn sample(pool: &crate::LanePool) -> serde_json::Value {
    #[cfg(windows)]
    let mut value = imp::sample();
    #[cfg(not(windows))]
    let mut value = serde_json::json!({
        "schema": "dsh-rust-exec/worker-metrics@1",
        "available": false,
        "reason": "unsupported platform",
    });

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

