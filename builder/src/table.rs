//! A large zeroed byte buffer. On Linux it asks for transparent huge pages:
//! the table is written at random offsets, and with 4 KB pages most of that
//! time goes to TLB misses rather than the writes themselves.

use std::ops::{Deref, DerefMut};

pub struct Table(Inner);

#[cfg(target_os = "linux")]
struct Inner {
    ptr: *mut u8,
    len: usize,
}

#[cfg(not(target_os = "linux"))]
struct Inner(Vec<u8>);

// SAFETY: the mapping is owned exclusively by this value.
unsafe impl Send for Table {}

#[cfg(target_os = "linux")]
mod sys {
    use std::ffi::c_void;
    pub const PROT_READ_WRITE: i32 = 0x1 | 0x2;
    pub const MAP_PRIVATE_ANONYMOUS: i32 = 0x02 | 0x20;
    pub const MADV_HUGEPAGE: i32 = 14;
    extern "C" {
        pub fn mmap(addr: *mut c_void, len: usize, prot: i32, flags: i32, fd: i32, off: i64) -> *mut c_void;
        pub fn madvise(addr: *mut c_void, len: usize, advice: i32) -> i32;
        pub fn munmap(addr: *mut c_void, len: usize) -> i32;
    }
}

impl Table {
    #[cfg(target_os = "linux")]
    pub fn zeroed(len: usize) -> std::io::Result<Table> {
        // SAFETY: plain anonymous mapping; the kernel hands back zeroed pages.
        unsafe {
            let p = sys::mmap(std::ptr::null_mut(), len, sys::PROT_READ_WRITE, sys::MAP_PRIVATE_ANONYMOUS, -1, 0);
            if p as isize == -1 {
                return Err(std::io::Error::last_os_error());
            }
            sys::madvise(p, len, sys::MADV_HUGEPAGE); // a hint; ignore failure
            Ok(Table(Inner { ptr: p.cast(), len }))
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub fn zeroed(len: usize) -> std::io::Result<Table> {
        Ok(Table(Inner(vec![0; len])))
    }
}

#[cfg(target_os = "linux")]
impl Drop for Table {
    fn drop(&mut self) {
        // SAFETY: ptr/len come from the mmap in `zeroed`.
        unsafe { sys::munmap(self.0.ptr.cast(), self.0.len) };
    }
}

impl Deref for Table {
    type Target = [u8];
    #[cfg(target_os = "linux")]
    fn deref(&self) -> &[u8] {
        // SAFETY: the mapping is valid for len bytes for the life of self.
        unsafe { std::slice::from_raw_parts(self.0.ptr, self.0.len) }
    }
    #[cfg(not(target_os = "linux"))]
    fn deref(&self) -> &[u8] {
        &self.0 .0
    }
}

impl DerefMut for Table {
    #[cfg(target_os = "linux")]
    fn deref_mut(&mut self) -> &mut [u8] {
        // SAFETY: as above, and &mut self gives exclusive access.
        unsafe { std::slice::from_raw_parts_mut(self.0.ptr, self.0.len) }
    }
    #[cfg(not(target_os = "linux"))]
    fn deref_mut(&mut self) -> &mut [u8] {
        &mut self.0 .0
    }
}
