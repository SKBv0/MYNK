fn main() {
    tauri_build::build();
    link_test_manifest();
}

/// Integration tests link a real Tauri `App`, which needs Common-Controls v6 (comctl32) or the
/// test binary dies at startup with `STATUS_ENTRYPOINT_NOT_FOUND`. Test targets only.
#[cfg(windows)]
fn link_test_manifest() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("tests.manifest");
    if !manifest.is_file() {
        return;
    }
    println!("cargo:rerun-if-changed=tests/tests.manifest");
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
        manifest.display()
    );
}

#[cfg(not(windows))]
fn link_test_manifest() {}
