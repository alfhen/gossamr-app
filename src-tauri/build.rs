fn main() {
    println!("cargo:rerun-if-env-changed=GOSSAMR_ATLASSIAN_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=GOSSAMR_ATLASSIAN_CLIENT_SECRET");
    tauri_build::build()
}
