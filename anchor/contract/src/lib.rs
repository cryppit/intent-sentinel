//! The NEAR anchor contract: one pin per closed UTC day, holding a head hash and a Merkle root.
//!
//! Built without near-sdk for `wasm32v1-none` (WebAssembly MVP + mutable globals, which the NEAR runtime accepts):
//! `logic` holds every rule and tests natively; `wasm` binds it to the NEAR host functions.
#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

pub mod logic;

#[cfg(target_arch = "wasm32")]
mod wasm;
