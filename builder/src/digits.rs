//! Streams the decimal digits of pi (the ones after the "3.") from disk.
//!
//! Two input formats are supported:
//! - y-cruncher `.ycd` files, the format Google publishes its 100 trillion
//!   digits in: a text header, then little-endian u64 words holding 19 digits
//!   each (most significant digit first).
//! - Plain text: any non-digit bytes are ignored and a leading "3." is dropped.
//!
//! Several inputs are read back to back, so `.ycd` files 0, 1, 2... can be
//! passed in order to go past the first 100 billion digits.

use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

const CHUNK_DIGITS: usize = 1 << 22;
const YCD_DIGITS_PER_WORD: usize = 19;
const YCD_MAGIC: &[u8] = b"#Compressed Digit File";

/// Calls `f` with consecutive chunks of digits (each byte is 0..=9) until the
/// inputs run out, `max_digits` is reached, or `f` returns false.
/// Returns the number of digits delivered.
pub fn for_each_chunk(
    inputs: &[PathBuf],
    max_digits: Option<u64>,
    mut f: impl FnMut(&[u8]) -> bool,
) -> io::Result<u64> {
    let mut total = 0u64;
    let mut buf = Vec::with_capacity(CHUNK_DIGITS + YCD_DIGITS_PER_WORD);
    for path in inputs {
        let mut reader = open(path)?;
        loop {
            buf.clear();
            let n = reader.fill(&mut buf)?;
            if n == 0 {
                break;
            }
            let mut take = buf.len();
            if let Some(max) = max_digits {
                take = take.min((max - total) as usize);
            }
            total += take as u64;
            if !f(&buf[..take]) || Some(total) == max_digits {
                return Ok(total);
            }
        }
    }
    Ok(total)
}

enum Reader {
    Ycd { inner: BufReader<File>, left: u64 },
    Text { inner: BufReader<File>, raw: Vec<u8>, at_start: bool },
}

fn open(path: &Path) -> io::Result<Reader> {
    let file = File::open(path)
        .map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", path.display())))?;
    let mut inner = BufReader::with_capacity(1 << 24, file);
    if inner.fill_buf()?.starts_with(YCD_MAGIC) {
        let left = read_ycd_header(&mut inner)?;
        Ok(Reader::Ycd { inner, left })
    } else {
        Ok(Reader::Text { inner, raw: vec![0; CHUNK_DIGITS], at_start: true })
    }
}

/// Consumes the header and returns how many digits the file holds.
fn read_ycd_header(r: &mut impl BufRead) -> io::Result<u64> {
    let bad = |msg: &str| io::Error::new(io::ErrorKind::InvalidData, msg.to_string());
    let mut block_size = None;
    let mut line = String::new();
    loop {
        line.clear();
        if r.read_line(&mut line)? == 0 {
            return Err(bad("ycd header has no EndHeader line"));
        }
        let l = line.trim();
        if l == "EndHeader" {
            break;
        }
        if let Some((key, value)) = l.split_once(':') {
            match key.trim() {
                "Base" if value.trim() != "10" => return Err(bad("only base-10 .ycd files are supported")),
                "Blocksize" => block_size = value.trim().parse::<u64>().ok(),
                _ => {}
            }
        }
    }
    // The header is padded with blank lines and ends with a NUL byte.
    let mut byte = [0u8; 1];
    loop {
        r.read_exact(&mut byte)?;
        match byte[0] {
            0 => break,
            b'\r' | b'\n' => {}
            _ => return Err(bad("unexpected byte after ycd header")),
        }
    }
    block_size.ok_or_else(|| bad("ycd header has no Blocksize"))
}

impl Reader {
    /// Appends up to about CHUNK_DIGITS digits to `out`; returns how many.
    fn fill(&mut self, out: &mut Vec<u8>) -> io::Result<usize> {
        match self {
            Reader::Ycd { inner, left } => {
                // The last word of a file can hold digits past Blocksize; `left`
                // stops us there so the next file continues at the right place.
                let mut word = [0u8; 8];
                while out.len() < CHUNK_DIGITS && *left > 0 {
                    match inner.read_exact(&mut word) {
                        Ok(()) => {}
                        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => break,
                        Err(e) => return Err(e),
                    }
                    let digits = word_digits(u64::from_le_bytes(word));
                    let take = (YCD_DIGITS_PER_WORD as u64).min(*left) as usize;
                    out.extend_from_slice(&digits[..take]);
                    *left -= take as u64;
                }
                Ok(out.len())
            }
            Reader::Text { inner, raw, at_start } => {
                while out.is_empty() {
                    let n = inner.read(raw)?;
                    if n == 0 {
                        return Ok(0);
                    }
                    let mut chunk = &raw[..n];
                    if *at_start {
                        let trimmed = chunk.trim_ascii_start();
                        if trimmed.is_empty() {
                            continue;
                        }
                        chunk = trimmed.strip_prefix(b"3.").unwrap_or(trimmed);
                        *at_start = false;
                    }
                    out.extend(chunk.iter().filter(|b| b.is_ascii_digit()).map(|b| b - b'0'));
                }
                Ok(out.len())
            }
        }
    }
}

fn word_digits(mut w: u64) -> [u8; YCD_DIGITS_PER_WORD] {
    let mut d = [0u8; YCD_DIGITS_PER_WORD];
    for slot in d.iter_mut().rev() {
        *slot = (w % 10) as u8;
        w /= 10;
    }
    d
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const PI_100: &str = "1415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679";

    fn collect(paths: &[PathBuf], max: Option<u64>) -> String {
        let mut s = String::new();
        for_each_chunk(paths, max, |c| {
            s.extend(c.iter().map(|d| (b'0' + d) as char));
            true
        })
        .unwrap();
        s
    }

    fn temp_file(name: &str, bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("pi-index-test-{}-{name}", std::process::id()));
        File::create(&path).unwrap().write_all(bytes).unwrap();
        path
    }

    /// Encodes digits the way y-cruncher does, including a padded final word.
    fn ycd(digits: &str) -> Vec<u8> {
        let mut out = format!(
            "#Compressed Digit File\r\n\r\nFileVersion:\t1.1.0\r\n\r\nBase:\t10\r\n\r\nBlocksize:\t{}\r\nBlockID:\t0\r\n\r\nEndHeader\r\n\r\n",
            digits.len()
        )
        .into_bytes();
        out.push(0);
        for chunk in digits.as_bytes().chunks(19) {
            let mut padded = chunk.to_vec();
            padded.resize(19, b'7'); // digits past Blocksize must be ignored
            let w: u64 = std::str::from_utf8(&padded).unwrap().parse().unwrap();
            out.extend_from_slice(&w.to_le_bytes());
        }
        out
    }

    #[test]
    fn reads_text_with_prefix_and_whitespace() {
        let p = temp_file("a.txt", format!("3.{}\n{}\n", &PI_100[..50], &PI_100[50..]).as_bytes());
        assert_eq!(collect(&[p], None), PI_100);
    }

    #[test]
    fn reads_ycd_and_stops_at_blocksize() {
        let p = temp_file("a.ycd", &ycd(PI_100));
        assert_eq!(collect(&[p], None), PI_100);
    }

    #[test]
    fn concatenates_inputs_and_honours_max() {
        let a = temp_file("b1.ycd", &ycd(&PI_100[..40]));
        let b = temp_file("b2.txt", &PI_100.as_bytes()[40..]);
        assert_eq!(collect(&[a.clone(), b.clone()], None), PI_100);
        assert_eq!(collect(&[a, b], Some(45)), &PI_100[..45]);
    }
}
