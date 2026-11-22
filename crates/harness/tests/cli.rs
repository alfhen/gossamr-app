use std::process::Command;

const HARNESS: &str = env!("CARGO_BIN_EXE_harness");

#[test]
fn version_prints_one_line_with_the_version_and_build_id_and_exits_zero() {
    let out = Command::new(HARNESS).arg("--version").output().unwrap();
    assert!(out.status.success(), "{out:?}");
    assert!(out.stderr.is_empty(), "{out:?}");
    assert_eq!(String::from_utf8(out.stdout).unwrap(), format!("{}\n", harness::version_line()));
}

#[test]
fn an_argument_that_is_not_utf8_prints_the_usage_and_exits_two() {
    use std::os::unix::ffi::OsStrExt;
    let out = Command::new(HARNESS).arg(std::ffi::OsStr::from_bytes(&[0xff])).output().unwrap();
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    assert_eq!(String::from_utf8(out.stderr).unwrap(), format!("{}\n", harness::USAGE));
}

#[test]
fn anything_else_prints_the_usage_and_exits_two() {
    for args in [&[][..], &["serve"]] {
        let out = Command::new(HARNESS).args(args).output().unwrap();
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(out.stdout.is_empty(), "{args:?}");
        assert_eq!(String::from_utf8(out.stderr).unwrap(), format!("{}\n", harness::USAGE));
    }
}
