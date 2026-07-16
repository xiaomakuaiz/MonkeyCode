fn main() {
    // 为应用自定义命令生成 ACL 权限(allow-<command>):
    // 远程源(主窗口加载的内核 UI,http://127.0.0.1)调用自定义命令必须显式授权。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "get_config",
                "save_config",
                "host_info",
                "update_check",
                "update_install",
            ]),
        ),
    )
    .expect("tauri_build 失败")
}
