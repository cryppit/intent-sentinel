//! NEAR host bindings for `logic`. Exports `pin` (change call) and the views `get_pin`, `last_pin` and
//! `contract_source_metadata` (NEP-330).
//!
//! The view methods touch only `input`, `storage_read` and `value_return`: the runtime refuses
//! `predecessor_account_id` and `attached_deposit` in a view call.

use crate::logic::{self, CallCtx, Store};
use alloc::string::String;
use alloc::vec::Vec;
use core::alloc::{GlobalAlloc, Layout};

#[allow(dead_code)]
mod sys {
    // NEAR runtime host functions (nearcore `near-vm-runner` imports, module "env"); every argument is a u64.
    extern "C" {
        pub fn read_register(register_id: u64, ptr: u64);
        pub fn register_len(register_id: u64) -> u64;
        pub fn current_account_id(register_id: u64);
        pub fn predecessor_account_id(register_id: u64);
        pub fn input(register_id: u64);
        pub fn block_index() -> u64;
        pub fn block_timestamp() -> u64;
        pub fn attached_deposit(balance_ptr: u64);
        pub fn value_return(value_len: u64, value_ptr: u64);
        pub fn panic_utf8(len: u64, ptr: u64) -> !;
        pub fn log_utf8(len: u64, ptr: u64);
        pub fn storage_write(key_len: u64, key_ptr: u64, value_len: u64, value_ptr: u64, register_id: u64) -> u64;
        pub fn storage_read(key_len: u64, key_ptr: u64, register_id: u64) -> u64;
    }
}

const REG: u64 = 0;

/// A bump allocator: each call runs in a fresh instance, so memory is never reused and never needs freeing.
struct Bump;

static mut NEXT: usize = 0;

unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        const PAGE: usize = 65_536;
        let mut next = NEXT;
        if next == 0 {
            next = core::arch::wasm32::memory_size(0) * PAGE;
        }
        let start = (next + layout.align() - 1) & !(layout.align() - 1);
        let end = match start.checked_add(layout.size()) {
            Some(e) => e,
            None => return core::ptr::null_mut(),
        };
        let have = core::arch::wasm32::memory_size(0) * PAGE;
        if end > have && core::arch::wasm32::memory_grow(0, (end - have).div_ceil(PAGE)) == usize::MAX {
            return core::ptr::null_mut();
        }
        NEXT = end;
        start as *mut u8
    }
    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: Layout) {}
}

#[global_allocator]
static ALLOC: Bump = Bump;

#[panic_handler]
fn on_panic(_: &core::panic::PanicInfo<'_>) -> ! {
    fail("anchor: internal error")
}

fn fail(msg: &str) -> ! {
    unsafe { sys::panic_utf8(msg.len() as u64, msg.as_ptr() as u64) }
}

fn register() -> Option<Vec<u8>> {
    let len = unsafe { sys::register_len(REG) };
    if len == u64::MAX {
        return None;
    }
    let mut buf = alloc::vec![0u8; len as usize];
    unsafe { sys::read_register(REG, buf.as_mut_ptr() as u64) };
    Some(buf)
}

fn input() -> Vec<u8> {
    unsafe { sys::input(REG) };
    register().unwrap_or_default()
}

fn account(read: unsafe extern "C" fn(u64)) -> String {
    unsafe { read(REG) };
    String::from_utf8(register().unwrap_or_default()).unwrap_or_default()
}

fn ret(bytes: &[u8]) {
    unsafe { sys::value_return(bytes.len() as u64, bytes.as_ptr() as u64) }
}

fn ret_json<T: serde::Serialize>(value: &T) {
    match serde_json::to_vec(value) {
        Ok(b) => ret(&b),
        Err(_) => fail("anchor: encode failed"),
    }
}

struct Trie;

impl Store for Trie {
    fn read(&self, key: &[u8]) -> Option<Vec<u8>> {
        let found = unsafe { sys::storage_read(key.len() as u64, key.as_ptr() as u64, REG) };
        if found == 1 {
            register()
        } else {
            None
        }
    }
    fn write(&mut self, key: &[u8], value: &[u8]) {
        unsafe { sys::storage_write(key.len() as u64, key.as_ptr() as u64, value.len() as u64, value.as_ptr() as u64, REG) };
    }
}

#[no_mangle]
pub extern "C" fn pin() {
    let predecessor = account(sys::predecessor_account_id);
    let current = account(sys::current_account_id);
    let mut deposit = [0u8; 16];
    unsafe { sys::attached_deposit(deposit.as_mut_ptr() as u64) };
    let ctx = CallCtx {
        predecessor: &predecessor,
        current_account: &current,
        attached_deposit: u128::from_le_bytes(deposit),
        block_height: unsafe { sys::block_index() },
        block_timestamp_ns: unsafe { sys::block_timestamp() },
    };
    match logic::pin(&mut Trie, &ctx, &input()) {
        Ok((record, event)) => {
            unsafe { sys::log_utf8(event.len() as u64, event.as_ptr() as u64) };
            ret_json(&record);
        }
        Err(e) => fail(&e),
    }
}

#[no_mangle]
pub extern "C" fn get_pin() {
    match logic::get_pin(&Trie, &input()) {
        Ok(p) => ret_json(&p),
        Err(e) => fail(&e),
    }
}

#[no_mangle]
pub extern "C" fn last_pin() {
    match logic::last_pin(&Trie) {
        Ok(p) => ret_json(&p),
        Err(e) => fail(&e),
    }
}

#[no_mangle]
pub extern "C" fn contract_source_metadata() {
    ret(&logic::contract_source_metadata());
}
