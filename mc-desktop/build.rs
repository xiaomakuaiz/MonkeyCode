fn main() {
    // 为应用自定义命令生成 ACL 权限(allow-<command>):
    // 远程源(主窗口加载的内核 UI,http://127.0.0.1)调用自定义命令必须显式授权;
    // 声明 AppManifest 后本地页面(设置/错误页)同样走 ACL,须在 capability 中一并引用。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "get_config",
                "save_config",
                "open_settings_window",
            ]),
        ),
    )
    .expect("tauri_build 失败")
}
