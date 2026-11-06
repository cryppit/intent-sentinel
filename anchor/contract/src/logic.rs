//! The anchor's rules, free of the NEAR host so they test natively (`cargo test`).
//!
//! One pin per UTC day of the station's journal: the day's last line hash (the chain head), the Merkle root over the
//! day's line hashes and their count. Pins are append-only: a day is pinned once and only once it is over at block
//! time (UTC), days only move forward, and each pin names the day pinned before it (`prev_pin`), so a skipped day is
//! visible on chain rather than hidden.

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

/// NEP-297 event standard name and version.
pub const EVENT_STANDARD: &str = "station_anchor";
pub const EVENT_VERSION: &str = "1.0.0";

/// Storage key of the last pinned day.
pub const LAST_KEY: &[u8] = b"last";

/// Arguments of `pin`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinArgs {
    /// UTC day, `YYYY-MM-DD`.
    pub day: String,
    /// sha256 hex (64 lowercase) of the day's last journal line.
    pub head_hash: String,
    /// RFC 6962 Merkle root (64 lowercase hex) over the day's line hashes, in journal order.
    pub merkle_root: String,
    /// Number of journal lines (Merkle leaves) in the day.
    pub leaf_count: u64,
    /// The day pinned before this one; `null` only for the first pin.
    pub prev_pin: Option<String>,
}

/// What the contract stores for a day and returns from the views.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pin {
    pub day: String,
    pub head_hash: String,
    pub merkle_root: String,
    pub leaf_count: u64,
    pub prev_pin: Option<String>,
    pub block_height: u64,
    /// Block timestamp in nanoseconds, as a decimal string (it does not fit a JSON number safely).
    pub block_timestamp_ns: String,
}

/// Arguments of `get_pin`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GetPinArgs {
    pub day: String,
}

/// Key-value storage, the NEAR trie on chain and a map in tests.
pub trait Store {
    fn read(&self, key: &[u8]) -> Option<Vec<u8>>;
    fn write(&mut self, key: &[u8], value: &[u8]);
}

/// The caller and block context of a `pin` call.
pub struct CallCtx<'a> {
    pub predecessor: &'a str,
    pub current_account: &'a str,
    pub attached_deposit: u128,
    pub block_height: u64,
    pub block_timestamp_ns: u64,
}

/// Storage key of a day's pin.
pub fn pin_key(day: &str) -> Vec<u8> {
    let mut key = b"p:".to_vec();
    key.extend_from_slice(day.as_bytes());
    key
}

/// Records a pin. Returns the stored record and the NEP-297 log line (`EVENT_JSON:{...}`).
pub fn pin(store: &mut dyn Store, ctx: &CallCtx<'_>, args_json: &[u8]) -> Result<(Pin, String), String> {
    if ctx.predecessor != ctx.current_account {
        return Err(format!("anchor: only {} may pin (called by {})", ctx.current_account, ctx.predecessor));
    }
    if ctx.attached_deposit != 0 {
        return Err("anchor: pin takes no deposit".to_string());
    }
    let args: PinArgs = serde_json::from_slice(args_json).map_err(|e| format!("anchor: bad arguments: {e}"))?;
    let Some(day_no) = day_number(&args.day) else {
        return Err(format!("anchor: day {:?} is not a YYYY-MM-DD date", args.day));
    };
    // Only a day that is over: one pin of a future day (a typo, a wrong clock, a leaked key) would otherwise refuse
    // every real pin as "not after the last pinned day" until that date, and forever once the account is locked.
    // The block day is at most u64::MAX / NS_PER_DAY = 213_503, so the cast is lossless.
    if day_no >= (ctx.block_timestamp_ns / NS_PER_DAY) as i64 {
        return Err(format!("anchor: day {} is not over at block time (pin closed UTC days only)", args.day));
    }
    if !is_hash_hex(&args.head_hash) {
        return Err("anchor: head_hash must be 64 lowercase hex characters".to_string());
    }
    if !is_hash_hex(&args.merkle_root) {
        return Err("anchor: merkle_root must be 64 lowercase hex characters".to_string());
    }
    if args.leaf_count == 0 {
        return Err("anchor: leaf_count must be at least 1 (a day with no journal lines is not pinned)".to_string());
    }
    let last = read_last_day(store)?;
    if let Some(last) = &last {
        if args.day.as_str() <= last.as_str() {
            return Err(format!("anchor: day {} is not after the last pinned day {}", args.day, last));
        }
    }
    if args.prev_pin != last {
        return Err(format!("anchor: prev_pin {:?} does not name the last pinned day {:?}", args.prev_pin, last));
    }
    let record = Pin {
        day: args.day,
        head_hash: args.head_hash,
        merkle_root: args.merkle_root,
        leaf_count: args.leaf_count,
        prev_pin: args.prev_pin,
        block_height: ctx.block_height,
        block_timestamp_ns: ctx.block_timestamp_ns.to_string(),
    };
    let bytes = serde_json::to_vec(&record).map_err(|e| format!("anchor: encode: {e}"))?;
    store.write(&pin_key(&record.day), &bytes);
    store.write(LAST_KEY, record.day.as_bytes());
    let event = serde_json::json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": "pin",
        "data": [record],
    });
    Ok((record, format!("EVENT_JSON:{event}")))
}

fn read_last_day(store: &dyn Store) -> Result<Option<String>, String> {
    match store.read(LAST_KEY) {
        None => Ok(None),
        Some(b) => String::from_utf8(b).map(Some).map_err(|_| "anchor: corrupt last-day entry".to_string()),
    }
}

fn read_pin(store: &dyn Store, day: &str) -> Result<Option<Pin>, String> {
    match store.read(&pin_key(day)) {
        None => Ok(None),
        Some(b) => serde_json::from_slice(&b).map(Some).map_err(|e| format!("anchor: corrupt pin {day}: {e}")),
    }
}

/// The pin of `day`, or `None`.
pub fn get_pin(store: &dyn Store, args_json: &[u8]) -> Result<Option<Pin>, String> {
    let args: GetPinArgs = serde_json::from_slice(args_json).map_err(|e| format!("anchor: bad arguments: {e}"))?;
    if !is_valid_day(&args.day) {
        return Err(format!("anchor: day {:?} is not a YYYY-MM-DD date", args.day));
    }
    read_pin(store, &args.day)
}

/// The most recent pin, or `None` before the first.
pub fn last_pin(store: &dyn Store) -> Result<Option<Pin>, String> {
    match read_last_day(store)? {
        None => Ok(None),
        Some(day) => read_pin(store, &day),
    }
}

/// A `NEP330_*` value as cargo-near's reproducible (Docker) build sets it at compile time, else the local build's value.
macro_rules! nep330_env {
    ($key:literal, $local:expr) => {
        match option_env!($key) {
            Some(v) if !v.is_empty() => v,
            _ => $local,
        }
    };
}

/// The NEP-330 values compiled into the binary.
pub struct BuildEnv {
    pub version: &'static str,
    pub link: &'static str,
    pub build_environment: &'static str,
    /// A JSON array of strings, the form cargo-near gives `NEP330_BUILD_INFO_BUILD_COMMAND`.
    pub build_command: &'static str,
    pub contract_path: &'static str,
    pub source_code_snapshot: &'static str,
    pub output_wasm_path: &'static str,
}

impl BuildEnv {
    /// `build.sh` sets no `NEP330_*` variable, so a local build carries the values after each name.
    pub fn compile_time() -> Self {
        BuildEnv {
            version: nep330_env!("NEP330_VERSION", env!("CARGO_PKG_VERSION")),
            link: nep330_env!("NEP330_LINK", "https://github.com/cryppit/intent-sentinel"),
            build_environment: nep330_env!("NEP330_BUILD_INFO_BUILD_ENVIRONMENT", "rust-toolchain.toml pinned toolchain"),
            build_command: nep330_env!("NEP330_BUILD_INFO_BUILD_COMMAND", r#"["anchor/contract/build.sh"]"#),
            contract_path: nep330_env!("NEP330_BUILD_INFO_CONTRACT_PATH", "anchor/contract"),
            source_code_snapshot: nep330_env!("NEP330_BUILD_INFO_SOURCE_CODE_SNAPSHOT", "git+https://github.com/cryppit/intent-sentinel"),
            output_wasm_path: nep330_env!("NEP330_BUILD_INFO_OUTPUT_WASM_PATH", "anchor/contract/res/station_anchor.wasm"),
        }
    }
}

/// NEP-330 source metadata (view `contract_source_metadata`): where the source of this binary lives and how to rebuild
/// it so its sha256 matches the account's `code_hash`. Fixed at compile time, so it can never change after deploy.
pub fn contract_source_metadata() -> Vec<u8> {
    metadata_from(&BuildEnv::compile_time())
}

/// `build_command` goes in as the JSON array it already is: parsing it in the contract would add ~8 KB of code.
pub fn metadata_from(env: &BuildEnv) -> Vec<u8> {
    let q = |s: &str| serde_json::to_string(s).unwrap_or_default();
    format!(
        concat!(
            r#"{{"version":{},"link":{},"standards":[{{"standard":"nep330","version":"1.3.0"}},{{"standard":"nep297","version":"1.0.0"}}],"#,
            r#""build_info":{{"build_environment":{},"build_command":{},"contract_path":{},"source_code_snapshot":{},"output_wasm_path":{}}}}}"#,
        ),
        q(env.version),
        q(env.link),
        q(env.build_environment),
        env.build_command,
        q(env.contract_path),
        q(env.source_code_snapshot),
        q(env.output_wasm_path),
    )
    .into_bytes()
}

/// Nanoseconds in a UTC day. NEAR's `block_timestamp` counts non-leap nanoseconds since 1970-01-01T00:00Z, so a block's
/// UTC day number is `block_timestamp_ns / NS_PER_DAY`.
pub const NS_PER_DAY: u64 = 86_400_000_000_000;

/// Year, month and day of a `YYYY-MM-DD` string naming a real Gregorian date (leap years included).
fn civil(day: &str) -> Option<(u32, u32, u32)> {
    let b = day.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |r: core::ops::Range<usize>| -> Option<u32> {
        b[r].iter().try_fold(0u32, |acc, &c| c.is_ascii_digit().then(|| acc * 10 + u32::from(c - b'0')))
    };
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days_in_month = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    (1..=days_in_month).contains(&d).then_some((y, m, d))
}

/// `YYYY-MM-DD` naming a real Gregorian date (leap years included).
pub fn is_valid_day(day: &str) -> bool {
    civil(day).is_some()
}

/// Days since 1970-01-01 (negative before it) of a `YYYY-MM-DD` day, or `None` if it is not a real date. Howard
/// Hinnant's `days_from_civil` on the proleptic Gregorian calendar: integer arithmetic only, no allocation.
pub fn day_number(day: &str) -> Option<i64> {
    let (y, m, d) = civil(day)?;
    let (m, d) = (i64::from(m), i64::from(d));
    let y = i64::from(y) - i64::from(m <= 2); // years start in March, so the leap day ends one
    let (era, yoe) = (y.div_euclid(400), y.rem_euclid(400)); // yoe in [0, 399]
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1; // [0, 365], counted from March 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    Some(era * 146_097 + doe - 719_468)
}

/// 64 lowercase hex characters.
pub fn is_hash_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct MapStore(BTreeMap<Vec<u8>, Vec<u8>>);
    impl Store for MapStore {
        fn read(&self, key: &[u8]) -> Option<Vec<u8>> {
            self.0.get(key).cloned()
        }
        fn write(&mut self, key: &[u8], value: &[u8]) {
            self.0.insert(key.to_vec(), value.to_vec());
        }
    }

    const ANCHOR: &str = "anchor.desk.testnet";
    const H1: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const H2: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    /// 2026-10-10T00:05Z, after every day the tests pin.
    const NOW_NS: u64 = 1_791_590_700_000_000_000;

    fn ctx(height: u64) -> CallCtx<'static> {
        CallCtx { predecessor: ANCHOR, current_account: ANCHOR, attached_deposit: 0, block_height: height, block_timestamp_ns: NOW_NS + height }
    }

    fn args(day: &str, prev: Option<&str>) -> Vec<u8> {
        let prev = prev.map_or("null".to_string(), |p| format!("\"{p}\""));
        format!(r#"{{"day":"{day}","head_hash":"{H1}","merkle_root":"{H2}","leaf_count":42,"prev_pin":{prev}}}"#).into_bytes()
    }

    fn err(r: Result<(Pin, String), String>) -> String {
        r.expect_err("expected an error")
    }

    #[test]
    fn first_pin_is_stored_returned_and_logged_as_a_nep297_event() {
        let mut s = MapStore::default();
        let (p, log) = pin(&mut s, &ctx(7), &args("2026-10-02", None)).unwrap();
        assert_eq!(p.day, "2026-10-02");
        assert_eq!(p.leaf_count, 42);
        assert_eq!(p.prev_pin, None);
        assert_eq!(p.block_height, 7);
        assert_eq!(p.block_timestamp_ns, "1791590700000000007");
        assert!(log.starts_with("EVENT_JSON:"));
        let ev: serde_json::Value = serde_json::from_str(&log["EVENT_JSON:".len()..]).unwrap();
        assert_eq!(ev["standard"], EVENT_STANDARD);
        assert_eq!(ev["version"], EVENT_VERSION);
        assert_eq!(ev["event"], "pin");
        assert_eq!(ev["data"][0]["day"], "2026-10-02");
        assert_eq!(ev["data"][0]["merkle_root"], H2);
        assert_eq!(get_pin(&s, br#"{"day":"2026-10-02"}"#).unwrap(), Some(p.clone()));
        assert_eq!(last_pin(&s).unwrap(), Some(p));
    }

    #[test]
    fn pins_chain_forward_and_a_gap_is_explicit() {
        let mut s = MapStore::default();
        pin(&mut s, &ctx(1), &args("2026-10-02", None)).unwrap();
        pin(&mut s, &ctx(2), &args("2026-10-03", Some("2026-10-02"))).unwrap();
        // 2026-10-04 skipped: allowed, the next pin names 2026-10-03 as its predecessor.
        let (p, _) = pin(&mut s, &ctx(3), &args("2026-10-05", Some("2026-10-03"))).unwrap();
        assert_eq!(p.prev_pin.as_deref(), Some("2026-10-03"));
        assert_eq!(last_pin(&s).unwrap().unwrap().day, "2026-10-05");
        assert_eq!(get_pin(&s, br#"{"day":"2026-10-04"}"#).unwrap(), None);
    }

    #[test]
    fn a_day_is_pinned_once_and_days_only_move_forward() {
        let mut s = MapStore::default();
        pin(&mut s, &ctx(1), &args("2026-10-02", None)).unwrap();
        assert!(err(pin(&mut s, &ctx(2), &args("2026-10-02", Some("2026-10-02")))).contains("not after"));
        assert!(err(pin(&mut s, &ctx(2), &args("2026-10-01", Some("2026-10-02")))).contains("not after"));
        let before = get_pin(&s, br#"{"day":"2026-10-02"}"#).unwrap().unwrap();
        assert_eq!(before.block_height, 1);
    }

    #[test]
    fn refuses_a_day_that_is_not_over_at_block_time() {
        // 2026-10-02T12:00Z: today, tomorrow and the far future are refused, yesterday is pinned.
        let noon = CallCtx { block_timestamp_ns: 1_790_942_400_000_000_000, ..ctx(1) };
        for day in ["2026-10-02", "2026-10-03", "9999-12-31"] {
            let e = err(pin(&mut MapStore::default(), &noon, &args(day, None)));
            assert!(e.contains("not over"), "{day}: {e}");
        }
        let mut s = MapStore::default();
        assert_eq!(pin(&mut s, &noon, &args("2026-10-01", None)).unwrap().0.day, "2026-10-01");
        assert_eq!(last_pin(&s).unwrap().unwrap().day, "2026-10-01");
    }

    #[test]
    fn a_day_is_over_from_the_first_nanosecond_of_the_next_utc_day() {
        let midnight = 1_790_985_600_000_000_000; // 2026-10-03T00:00Z
        let at = |ns: u64| CallCtx { block_timestamp_ns: ns, ..ctx(1) };
        assert!(err(pin(&mut MapStore::default(), &at(midnight - 1), &args("2026-10-02", None))).contains("not over"));
        assert!(pin(&mut MapStore::default(), &at(midnight), &args("2026-10-02", None)).is_ok());
    }

    #[test]
    fn day_number_matches_known_dates() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("2000-02-29"), Some(11_016));
        assert_eq!(day_number("2026-10-02"), Some(20_728));
        assert_eq!(day_number("2026-10-04"), Some(20_730));
        assert_eq!(day_number("1969-12-31"), Some(-1));
        assert_eq!(day_number("0000-03-01"), Some(-719_468));
        assert_eq!(day_number("9999-12-31"), Some(2_932_896));
        assert_eq!(day_number("2026-10-10"), Some((NOW_NS / NS_PER_DAY) as i64));
        for bad in ["2026-02-30", "2026-13-01", "not a day!", ""] {
            assert_eq!(day_number(bad), None, "{bad}");
        }
    }

    #[test]
    fn prev_pin_must_name_the_last_pinned_day() {
        let mut s = MapStore::default();
        assert!(err(pin(&mut s, &ctx(1), &args("2026-10-02", Some("2026-10-01")))).contains("prev_pin"));
        pin(&mut s, &ctx(1), &args("2026-10-02", None)).unwrap();
        assert!(err(pin(&mut s, &ctx(2), &args("2026-10-03", None))).contains("prev_pin"));
        assert!(err(pin(&mut s, &ctx(2), &args("2026-10-03", Some("2026-10-01")))).contains("prev_pin"));
    }

    #[test]
    fn only_the_anchor_account_itself_may_pin_and_without_a_deposit() {
        let mut s = MapStore::default();
        let mut c = ctx(1);
        c.predecessor = "someone.testnet";
        assert!(err(pin(&mut s, &c, &args("2026-10-02", None))).contains("only"));
        let mut c = ctx(1);
        c.attached_deposit = 1;
        assert!(err(pin(&mut s, &c, &args("2026-10-02", None))).contains("deposit"));
        assert_eq!(last_pin(&s).unwrap(), None);
    }

    #[test]
    fn rejects_malformed_arguments() {
        let mut s = MapStore::default();
        let bad = |json: &str| -> String { err(pin(&mut MapStore::default(), &ctx(1), json.as_bytes())) };
        assert!(bad("not json").contains("arguments"));
        assert!(bad(&format!(r#"{{"day":"2026-10-02","head_hash":"{H1}","merkle_root":"{H2}","leaf_count":1,"prev_pin":null,"x":1}}"#)).contains("arguments"));
        assert!(bad(&format!(r#"{{"day":"2026-02-30","head_hash":"{H1}","merkle_root":"{H2}","leaf_count":1,"prev_pin":null}}"#)).contains("day"));
        assert!(bad(&format!(r#"{{"day":"2026-10-02","head_hash":"{}","merkle_root":"{H2}","leaf_count":1,"prev_pin":null}}"#, "AB".repeat(32))).contains("head_hash"));
        assert!(bad(&format!(r#"{{"day":"2026-10-02","head_hash":"{H1}","merkle_root":"abc","leaf_count":1,"prev_pin":null}}"#)).contains("merkle_root"));
        assert!(bad(&format!(r#"{{"day":"2026-10-02","head_hash":"{H1}","merkle_root":"{H2}","leaf_count":0,"prev_pin":null}}"#)).contains("leaf_count"));
        assert_eq!(last_pin(&s).unwrap(), None);
        let _ = &mut s;
    }

    #[test]
    fn get_pin_validates_its_argument() {
        let s = MapStore::default();
        assert!(get_pin(&s, b"{}").unwrap_err().contains("arguments"));
        assert!(get_pin(&s, br#"{"day":"2026-13-01"}"#).unwrap_err().contains("day"));
    }

    #[test]
    fn contract_source_metadata_follows_nep330() {
        let v: serde_json::Value = serde_json::from_slice(&contract_source_metadata()).unwrap();
        assert_eq!(v["version"], "1.2.0");
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(v["link"], "https://github.com/cryppit/intent-sentinel");
        assert_eq!(
            v["standards"],
            serde_json::json!([{"standard": "nep330", "version": "1.3.0"}, {"standard": "nep297", "version": "1.0.0"}])
        );
        let b = &v["build_info"];
        assert_eq!(b["build_environment"], "rust-toolchain.toml pinned toolchain");
        assert_eq!(b["build_command"], serde_json::json!(["anchor/contract/build.sh"]));
        assert_eq!(b["contract_path"], "anchor/contract");
        assert_eq!(b["source_code_snapshot"], "git+https://github.com/cryppit/intent-sentinel");
        assert_eq!(b["output_wasm_path"], "anchor/contract/res/station_anchor.wasm");
        assert_eq!(v.as_object().unwrap().len(), 4);
        assert_eq!(b.as_object().unwrap().len(), 5);
    }

    #[test]
    fn contract_source_metadata_carries_what_a_cargo_near_build_sets() {
        let env = BuildEnv {
            version: "1.2.0",
            link: "https://github.com/cryppit/anchor",
            build_environment: "sourcescan/cargo-near:0.13.5-rust-1.85.1@sha256:0123",
            build_command: r#"["cargo","near","build","non-reproducible-wasm","--locked"]"#,
            contract_path: "anchor/contract",
            source_code_snapshot: "git+https://github.com/cryppit/anchor?rev=0123456789abcdef0123456789abcdef01234567",
            output_wasm_path: "/home/near/code/anchor/contract/target/near/station_anchor.wasm",
        };
        let v: serde_json::Value = serde_json::from_slice(&metadata_from(&env)).unwrap();
        assert_eq!((v["version"].as_str(), v["link"].as_str()), (Some(env.version), Some(env.link)));
        let b = &v["build_info"];
        assert_eq!(b["build_environment"], env.build_environment);
        assert_eq!(b["build_command"], serde_json::json!(["cargo", "near", "build", "non-reproducible-wasm", "--locked"]));
        assert_eq!(b["source_code_snapshot"], env.source_code_snapshot);
        assert_eq!(b["output_wasm_path"], env.output_wasm_path);
    }

    #[test]
    fn day_and_hash_validation() {
        for ok in ["2026-10-02", "2024-02-29", "2000-02-29", "1999-12-31"] {
            assert!(is_valid_day(ok), "{ok}");
        }
        for bad in ["2026-1-02", "2026-10-2", "2026/10/02", "2026-00-10", "2026-10-00", "2026-04-31", "2025-02-29", "1900-02-29", "2026-10-02 ", "２026-10-02"] {
            assert!(!is_valid_day(bad), "{bad}");
        }
        assert!(is_hash_hex(H1));
        assert!(!is_hash_hex(&H1[1..]));
        assert!(!is_hash_hex(&H1.replace('1', "g")));
        assert!(!is_hash_hex(&H1.replace('1', "A")));
    }
}
