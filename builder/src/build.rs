//! Builds the first-occurrence tables.
//!
//! Every table is a flat array of 5-byte little-endian entries. Entry `n`
//! holds the 1-based position (counting digits after the "3.") where the
//! number `n` first starts, or 0 if it was not seen.
//!
//! - `short/len{k}.bin` for k = 1..=SHORT_MAX: one entry per k-digit number.
//! - `len{W}/{d}.bin` for d = 0..=9: one entry per W-digit number starting
//!   with d, indexed by its last W-1 digits. With W = 10 each file is 5 GB.
//!   Queries of SHORT_MAX+1..W digits are answered from these files by taking
//!   the smallest entry over every W-digit extension of the query.

use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::digits::for_each_chunk;
use crate::table::Table;

pub const ENTRY: usize = 5;
pub const SHORT_MAX: u32 = 5;
const MAX_POSITION: u64 = (1 << 40) - 1;
const PROGRESS_EVERY: u64 = 1_000_000_000;
const PREFETCH_AHEAD: usize = 16;

pub struct Config {
    pub inputs: Vec<PathBuf>,
    pub out: PathBuf,
    pub width: u32,
    pub first_digits: Vec<u8>,
    pub threads: usize,
    pub max_digits: Option<u64>,
}

pub fn run(cfg: &Config) -> io::Result<()> {
    fs::create_dir_all(cfg.out.join("short"))?;
    fs::create_dir_all(cfg.out.join(format!("len{}", cfg.width)))?;
    build_short(cfg)?;

    let todo: Vec<u8> = cfg
        .first_digits
        .iter()
        .copied()
        .filter(|&d| {
            let done = long_path(cfg, d).exists();
            if done {
                eprintln!("len{}/{d}.bin already exists, skipping", cfg.width);
            }
            !done
        })
        .collect();

    let mut digits_seen = None;
    for group in todo.chunks(cfg.threads.max(1)) {
        let results: Vec<io::Result<u64>> = std::thread::scope(|s| {
            let handles: Vec<_> = group.iter().map(|&d| s.spawn(move || build_long(cfg, d))).collect();
            handles.into_iter().map(|h| h.join().expect("builder thread panicked")).collect()
        });
        for r in results {
            digits_seen = Some(r?);
        }
    }
    if let Some(n) = digits_seen {
        write_meta(cfg, n)?;
    }
    Ok(())
}

fn long_path(cfg: &Config, first: u8) -> PathBuf {
    cfg.out.join(format!("len{}/{first}.bin", cfg.width))
}

/// Short numbers all show up within the first few million digits, so this
/// stops reading as soon as every table is full.
fn build_short(cfg: &Config) -> io::Result<()> {
    let max_k = SHORT_MAX.min(cfg.width);
    let mut tables: Vec<Vec<u64>> = (1..=max_k).map(|k| vec![0; 10usize.pow(k)]).collect();
    let mut missing: Vec<usize> = tables.iter().map(Vec::len).collect();
    let mut rolling = vec![0u64; max_k as usize];
    let mut i = 0u64; // 0-based index of the current digit

    for_each_chunk(&cfg.inputs, cfg.max_digits, |chunk| {
        for &d in chunk {
            for k in 1..=max_k as usize {
                let modulus = 10u64.pow(k as u32 - 1);
                rolling[k - 1] = (rolling[k - 1] % modulus) * 10 + d as u64;
                if i + 1 >= k as u64 {
                    let slot = &mut tables[k - 1][rolling[k - 1] as usize];
                    if *slot == 0 {
                        *slot = i + 2 - k as u64;
                        missing[k - 1] -= 1;
                    }
                }
            }
            i += 1;
        }
        missing.iter().any(|&m| m > 0)
    })?;

    for (k, table) in (1..).zip(&tables) {
        let mut w = BufWriter::new(File::create(cfg.out.join(format!("short/len{k}.bin")))?);
        for &p in table {
            w.write_all(&p.to_le_bytes()[..ENTRY])?;
        }
        w.flush()?;
    }
    eprintln!("short tables (1..={max_k} digits) done after {i} digits");
    Ok(())
}

/// Scans every input digit once and fills the table for W-digit numbers that
/// start with `first`. Returns how many digits were scanned.
fn build_long(cfg: &Config, first: u8) -> io::Result<u64> {
    let width = cfg.width;
    let span = 10u64.pow(width - 1);
    let mut table = Table::zeroed(span as usize * ENTRY)?;
    let mut filled = 0u64;
    let mut rolling = 0u64;
    let mut i = 0u64;
    let mut next_report = PROGRESS_EVERY;
    let started = Instant::now();
    let mut overflow = false;
    let (lo, hi) = (first as u64 * span, (first as u64 + 1) * span);
    let mut hits: Vec<(u32, u64)> = Vec::new();

    for_each_chunk(&cfg.inputs, cfg.max_digits, |chunk| {
        if i + chunk.len() as u64 > MAX_POSITION {
            overflow = true;
            return false;
        }
        // Collect this chunk's matches first, then apply them in order while
        // prefetching a few ahead, so many cache misses are in flight at once.
        hits.clear();
        for &d in chunk {
            rolling = (rolling % span) * 10 + d as u64;
            i += 1;
            if rolling >= lo && rolling < hi && i >= width as u64 {
                hits.push(((rolling - lo) as u32, i + 1 - width as u64));
            }
        }
        for (j, &(idx, pos)) in hits.iter().enumerate() {
            if let Some(&(ahead, _)) = hits.get(j + PREFETCH_AHEAD) {
                prefetch(&table[ahead as usize * ENTRY]);
            }
            let at = idx as usize * ENTRY;
            let slot = &mut table[at..at + ENTRY];
            if slot == [0; ENTRY] {
                slot.copy_from_slice(&pos.to_le_bytes()[..ENTRY]);
                filled += 1;
            }
        }
        if i >= next_report {
            next_report += PROGRESS_EVERY;
            eprintln!(
                "[first digit {first}] {:.1}B digits read, {:.3}% of table filled, {:.0}s",
                i as f64 / 1e9,
                100.0 * filled as f64 / span as f64,
                started.elapsed().as_secs_f64()
            );
        }
        true
    })?;
    if overflow {
        return Err(io::Error::other("position does not fit in 5 bytes"));
    }

    // Write to a temp name first so an interrupted run is never mistaken for
    // a finished file on resume.
    let path = long_path(cfg, first);
    let tmp = path.with_extension("bin.partial");
    write_all_to(&tmp, &table)?;
    fs::rename(&tmp, &path)?;
    eprintln!(
        "[first digit {first}] done: {:.4}% of {width}-digit numbers starting with {first} found in {i} digits ({:.0}s)",
        100.0 * filled as f64 / span as f64,
        started.elapsed().as_secs_f64()
    );
    Ok(i)
}

#[inline(always)]
fn prefetch(p: &u8) {
    #[cfg(target_arch = "x86_64")]
    // SAFETY: prefetching is only a hint and never faults.
    unsafe {
        use std::arch::x86_64::{_mm_prefetch, _MM_HINT_T0};
        _mm_prefetch::<_MM_HINT_T0>((p as *const u8).cast());
    }
    #[cfg(not(target_arch = "x86_64"))]
    let _ = p;
}

fn write_all_to(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut f = File::create(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

fn write_meta(cfg: &Config, digits: u64) -> io::Result<()> {
    let json = format!(
        "{{\n  \"width\": {},\n  \"shortMax\": {},\n  \"digits\": {}\n}}\n",
        cfg.width,
        SHORT_MAX.min(cfg.width),
        digits
    );
    fs::write(cfg.out.join("meta.json"), json)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic pseudo-random digits; the tables don't care whether it's pi.
    fn test_digits(n: usize) -> String {
        let mut x = 0x2545_f491_4f6c_dd1du64;
        (0..n)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                (b'0' + (x % 10) as u8) as char
            })
            .collect()
    }

    fn entry(bytes: &[u8], n: usize) -> u64 {
        let mut b = [0u8; 8];
        b[..ENTRY].copy_from_slice(&bytes[n * ENTRY..(n + 1) * ENTRY]);
        u64::from_le_bytes(b)
    }

    fn brute_first(digits: &str, q: &str) -> u64 {
        digits.find(q).map_or(0, |i| i as u64 + 1)
    }

    #[test]
    fn tables_match_brute_force() {
        let dir = std::env::temp_dir().join(format!("pi-index-build-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("pi.txt");
        let digits = test_digits(1500);
        fs::write(&input, &digits).unwrap();
        let cfg = Config {
            inputs: vec![input],
            out: dir.join("out"),
            width: 3,
            first_digits: (0..10).collect(),
            threads: 4,
            max_digits: None,
        };
        run(&cfg).unwrap();

        for k in 1..=3u32 {
            let t = fs::read(dir.join(format!("out/short/len{k}.bin"))).unwrap();
            for n in 0..10usize.pow(k) {
                let q = format!("{n:0width$}", width = k as usize);
                assert_eq!(entry(&t, n), brute_first(&digits, &q), "short {q}");
            }
        }
        for first in 0..10 {
            let t = fs::read(dir.join(format!("out/len3/{first}.bin"))).unwrap();
            for rest in 0..100 {
                let q = format!("{first}{rest:02}");
                assert_eq!(entry(&t, rest), brute_first(&digits, &q), "long {q}");
            }
        }
        let meta = fs::read_to_string(dir.join("out/meta.json")).unwrap();
        assert!(meta.contains("\"digits\": 1500"), "{meta}");
    }
}
