mod build;
mod digits;
mod table;

use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "\
Builds the Find in Pi lookup tables.

usage: pi-index --out DIR [options] INPUT...

INPUT is a y-cruncher .ycd file (e.g. Google's \"Pi - Dec - Chudnovsky - 0.ycd\")
or a plain text file of digits. Several inputs are read in order.

options:
  --out DIR             where to write short/, len<W>/ and meta.json
  --width W             longest searchable number (default 10)
  --first-digits LIST   which len<W>/<d>.bin files to build, e.g. 0-4 or 1,7
                        (default 0-9; files that already exist are skipped)
  --threads N           files built at the same time (default 1). Each one
                        holds 5 * 10^(W-1) bytes in RAM: 5 GB for W = 10.
  --max-digits N        stop reading after N digits
";

fn main() -> ExitCode {
    match parse(std::env::args().skip(1).collect()) {
        Ok(cfg) => match build::run(&cfg) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("error: {e}");
                ExitCode::FAILURE
            }
        },
        Err(msg) => {
            eprintln!("{msg}\n\n{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn parse(args: Vec<String>) -> Result<build::Config, String> {
    let mut cfg = build::Config {
        inputs: vec![],
        out: PathBuf::new(),
        width: 10,
        first_digits: (0..10).collect(),
        threads: 1,
        max_digits: None,
    };
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        let mut value = |name: &str| it.next().ok_or(format!("{name} needs a value"));
        match arg.as_str() {
            "-h" | "--help" => return Err(String::new()),
            "--out" => cfg.out = value("--out")?.into(),
            "--width" => cfg.width = number(&value("--width")?)?,
            "--threads" => cfg.threads = number(&value("--threads")?)?,
            "--max-digits" => cfg.max_digits = Some(number(&value("--max-digits")?)?),
            "--first-digits" => cfg.first_digits = digit_list(&value("--first-digits")?)?,
            s if s.starts_with("--") => return Err(format!("unknown option {s}")),
            _ => cfg.inputs.push(arg.into()),
        }
    }
    if cfg.out.as_os_str().is_empty() {
        return Err("--out is required".into());
    }
    if cfg.inputs.is_empty() {
        return Err("no input files given".into());
    }
    if !(1..=12).contains(&cfg.width) {
        return Err("--width must be between 1 and 12".into());
    }
    Ok(cfg)
}

fn number<T: std::str::FromStr>(s: &str) -> Result<T, String> {
    s.replace('_', "").parse().map_err(|_| format!("not a number: {s}"))
}

/// Parses "0-9", "3" or "1,4,7-9".
fn digit_list(s: &str) -> Result<Vec<u8>, String> {
    let digit = |p: &str| match p.trim().parse::<u8>() {
        Ok(d) if d <= 9 => Ok(d),
        _ => Err(format!("not a digit: {p}")),
    };
    let mut out = vec![];
    for part in s.split(',') {
        match part.split_once('-') {
            Some((a, b)) => out.extend(digit(a)?..=digit(b)?),
            None => out.push(digit(part)?),
        }
    }
    out.sort_unstable();
    out.dedup();
    Ok(out)
}
