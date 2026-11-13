fn main() {
    println!("cargo:rerun-if-changed=prepare-ffmpeg.ps1");
    let target = std::env::var("TARGET").expect("Cargo sets TARGET");
    assert_eq!(
        target, "x86_64-pc-windows-msvc",
        "MiniVidCut bundles FFmpeg for Windows x64"
    );
    let status = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            "prepare-ffmpeg.ps1",
        ])
        .status()
        .expect("Could not run FFmpeg build preparation");
    assert!(status.success(), "Could not prepare bundled FFmpeg");
    tauri_build::build();
}
