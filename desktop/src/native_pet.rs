//! Windows 原生桌宠绘制。
//!
//! WebView2 在 Windows 7 上明确不支持透明 DefaultBackgroundColor,
//! HTML 的 transparent 最终会与白底合成。本模块只在 Windows 编译:
//! 可见窗口是无 WebView 的 Tauri Window,帧画面以预乘 BGRA 经
//! UpdateLayeredWindow 提交,因而 Win7/10/11 共用同一套逐像素 alpha。

use std::ffi::c_void;
use std::mem::size_of;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Window};
use windows::core::w;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject, DrawTextW, GetDC,
    ReleaseDC, SelectObject, SetBkMode, SetTextColor, AC_SRC_ALPHA, AC_SRC_OVER,
    ANTIALIASED_QUALITY, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION, CLIP_DEFAULT_PRECIS,
    DEFAULT_CHARSET, DEFAULT_PITCH, DIB_RGB_COLORS, DT_CENTER, DT_END_ELLIPSIS, DT_NOPREFIX,
    DT_SINGLELINE, DT_VCENTER, FW_NORMAL, HGDIOBJ, OUT_DEFAULT_PRECIS, TRANSPARENT,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows::Win32::UI::Shell::{
    DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass, SUBCLASSPROC,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetWindowLongPtrW, GetWindowRect, KillTimer, PostMessageW, SetTimer,
    SetWindowLongPtrW, SetWindowPos, UpdateLayeredWindow, GWL_EXSTYLE, SWP_NOACTIVATE, SWP_NOSIZE,
    SWP_NOZORDER, ULW_ALPHA, WM_APP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCDESTROY,
    WM_TIMER, WS_EX_LAYERED,
};

const LOGICAL_H: f64 = 120.0;
const LOGICAL_SPRITE: f64 = 88.0;
const SOURCE_FRAME: usize = 176;
const FRAME_COUNT: usize = 31;
const SUBCLASS_ID: usize = 0x4D43_5045_54; // "MCPET"
const TIMER_ID: usize = 0x5045_54;
const TIMER_MS: u32 = 100;
const WM_RENDER: u32 = WM_APP + 0x51;

/// App 级句柄:命令线程只更新快照并 PostMessage,所有 GDI/窗口操作
/// 仍在创建窗口的 UI 线程上完成。
pub struct NativePetHost(Mutex<Option<Arc<NativePet>>>);

impl NativePetHost {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    fn set(&self, pet: Arc<NativePet>) {
        *self.0.lock().unwrap() = Some(pet);
    }

    fn get(&self) -> Option<Arc<NativePet>> {
        self.0.lock().unwrap().clone()
    }

    fn take(&self) -> Option<Arc<NativePet>> {
        self.0.lock().unwrap().take()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Offline,
    Idle,
    Running,
    Waiting,
    Celebrate,
}

#[derive(Clone, Copy)]
enum Tone {
    Normal,
    Ok,
    Warn,
    Error,
}

struct VisualState {
    mode: Mode,
    tone: Tone,
    text: String,
    since: Instant,
    generation: u64,
    last_key: Option<(usize, u64, u32, u32)>,
}

impl Default for VisualState {
    fn default() -> Self {
        Self {
            mode: Mode::Offline,
            tone: Tone::Normal,
            text: "内核休息中 Zzz".into(),
            since: Instant::now(),
            generation: 0,
            last_key: None,
        }
    }
}

#[derive(Default)]
struct MouseState {
    down: bool,
    dragged: bool,
    cursor: POINT,
    origin: RECT,
}

struct NativePet {
    // HWND 的裸指针包装不实现 Send/Sync。这里只跨线程保存其数值，所有实际
    // 窗口/GDI 调用仍通过 PostMessage 回到创建窗口的 UI 线程。
    hwnd: isize,
    app: AppHandle,
    /// 31 帧横条,2x 源图(5456x176),RGBA row-major。
    sprite: tauri::image::Image<'static>,
    visual: Mutex<VisualState>,
    mouse: Mutex<MouseState>,
}

/// 把 Tauri 原生窗口转成逐像素 alpha 的 layered window,并安装动画/拖动子类过程。
pub fn attach(app: &AppHandle, window: &Window) -> Result<(), String> {
    let sprite = tauri::image::Image::from_bytes(include_bytes!("assets/pet-sprite.png"))
        .map_err(|e| format!("桌宠 PNG 解码失败: {e}"))?
        .to_owned();
    if sprite.width() as usize != SOURCE_FRAME * FRAME_COUNT
        || sprite.height() as usize != SOURCE_FRAME
    {
        return Err(format!(
            "桌宠精灵图尺寸异常: {}x{}",
            sprite.width(),
            sprite.height()
        ));
    }

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("获取桌宠 HWND 失败: {e}"))?;
    let pet = Arc::new(NativePet {
        hwnd: hwnd.0 as isize,
        app: app.clone(),
        sprite,
        visual: Mutex::new(VisualState::default()),
        mouse: Mutex::new(MouseState::default()),
    });

    unsafe {
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_LAYERED.0 as isize);

        // 子类回调持有独立 Arc,到 WM_NCDESTROY 时归还;
        // Host 另持一份,用于 IPC 线程更新状态。
        let callback_ref = Arc::into_raw(pet.clone()) as usize;
        if !SetWindowSubclass(
            hwnd,
            SUBCLASSPROC::Some(window_proc),
            SUBCLASS_ID,
            callback_ref,
        )
        .as_bool()
        {
            drop(Arc::from_raw(callback_ref as *const NativePet));
            return Err("安装桌宠窗口过程失败".into());
        }
        if SetTimer(Some(hwnd), TIMER_ID, TIMER_MS, None) == 0 {
            let _ = RemoveWindowSubclass(hwnd, SUBCLASSPROC::Some(window_proc), SUBCLASS_ID);
            drop(Arc::from_raw(callback_ref as *const NativePet));
            return Err("创建桌宠动画定时器失败".into());
        }
    }

    app.state::<NativePetHost>().set(pet.clone());
    pet.render(true);
    Ok(())
}

/// 由隐藏 pet-service WebView 推送已聚合的视觉状态。
pub fn update(app: &AppHandle, mode: &str, tone: &str, text: &str) {
    let pet = app.state::<NativePetHost>().get();
    let Some(pet) = pet else { return };
    {
        let mut visual = pet.visual.lock().unwrap();
        visual.mode = match mode {
            "idle" => Mode::Idle,
            "running" => Mode::Running,
            "waiting" => Mode::Waiting,
            "celebrate" => Mode::Celebrate,
            _ => Mode::Offline,
        };
        visual.tone = match tone {
            "ok" => Tone::Ok,
            "warn" => Tone::Warn,
            "err" => Tone::Error,
            _ => Tone::Normal,
        };
        // IPC 载荷受壳内页控制,仍在原生边界做长度上限。
        visual.text = text.chars().take(80).collect();
        visual.since = Instant::now();
        visual.generation = visual.generation.wrapping_add(1);
    }
    unsafe {
        let _ = PostMessageW(Some(pet.hwnd()), WM_RENDER, WPARAM(0), LPARAM(0));
    }
}

pub fn rerender(app: &AppHandle) {
    let pet = app.state::<NativePetHost>().get();
    if let Some(pet) = pet {
        pet.visual.lock().unwrap().last_key = None;
        unsafe {
            let _ = PostMessageW(Some(pet.hwnd()), WM_RENDER, WPARAM(0), LPARAM(0));
        }
    }
}

pub fn shutdown(app: &AppHandle) {
    let pet = app.state::<NativePetHost>().take();
    if let Some(pet) = pet {
        unsafe {
            let _ = KillTimer(Some(pet.hwnd()), TIMER_ID);
        }
    }
}

impl NativePet {
    fn hwnd(&self) -> HWND {
        HWND(self.hwnd as *mut c_void)
    }

    fn frame_at(mode: Mode, elapsed: Duration) -> usize {
        let ms = elapsed.as_millis() as usize;
        match mode {
            Mode::Idle => (ms / 2500) % 7,
            Mode::Running => 7 + (ms / 133) % 9,
            Mode::Waiting => 16 + (ms / 229) % 7,
            Mode::Celebrate => 23 + (ms / 200).min(6),
            Mode::Offline => 30,
        }
    }

    fn render(&self, force: bool) {
        let mut client = RECT::default();
        if unsafe { GetClientRect(self.hwnd(), &mut client) }.is_err() {
            return;
        }
        let width = (client.right - client.left).max(1) as u32;
        let height = (client.bottom - client.top).max(1) as u32;

        let (frame, tone, text, mode) = {
            let mut visual = self.visual.lock().unwrap();
            let frame = Self::frame_at(visual.mode, visual.since.elapsed());
            let key = (frame, visual.generation, width, height);
            if !force && visual.last_key == Some(key) {
                return;
            }
            visual.last_key = Some(key);
            (frame, visual.tone, visual.text.clone(), visual.mode)
        };

        if let Err(e) = self.render_frame(width, height, frame, mode, tone, &text) {
            eprintln!("[desktop] 桌宠原生绘制失败: {e}");
        }
    }

    fn render_frame(
        &self,
        width: u32,
        height: u32,
        frame: usize,
        mode: Mode,
        tone: Tone,
        text: &str,
    ) -> Result<(), String> {
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let scale = (height as f64 / LOGICAL_H).max(0.5);
        let sprite_size = (LOGICAL_SPRITE * scale).round().max(1.0) as u32;
        let sprite_x = (width.saturating_sub(sprite_size) / 2) as i32;
        let sprite_y = height.saturating_sub(sprite_size) as i32;
        self.draw_sprite(
            &mut pixels,
            width,
            height,
            frame,
            mode,
            sprite_x,
            sprite_y,
            sprite_size,
        );

        let bubble = if text.is_empty() {
            None
        } else {
            Some(draw_bubble(&mut pixels, width, height, scale, tone, text))
        };

        unsafe { self.commit_bitmap(width, height, &mut pixels, bubble.as_ref()) }
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_sprite(
        &self,
        dst: &mut [u8],
        dst_w: u32,
        dst_h: u32,
        frame: usize,
        mode: Mode,
        dx: i32,
        dy: i32,
        size: u32,
    ) {
        let src = self.sprite.rgba();
        let src_w = self.sprite.width() as usize;
        let sx0 = frame * SOURCE_FRAME;
        for y in 0..size {
            let sy = ((y as usize * SOURCE_FRAME) / size as usize).min(SOURCE_FRAME - 1);
            let oy = dy + y as i32;
            if oy < 0 || oy >= dst_h as i32 {
                continue;
            }
            for x in 0..size {
                let sx = ((x as usize * SOURCE_FRAME) / size as usize).min(SOURCE_FRAME - 1);
                let ox = dx + x as i32;
                if ox < 0 || ox >= dst_w as i32 {
                    continue;
                }
                let si = (sy * src_w + sx0 + sx) * 4;
                let mut r = src[si] as u32;
                let mut g = src[si + 1] as u32;
                let mut b = src[si + 2] as u32;
                let mut a = src[si + 3] as u32;
                if mode == Mode::Offline {
                    let gray = (r * 54 + g * 183 + b * 19) / 256;
                    r = ((r * 3 + gray * 7) / 10) * 92 / 100;
                    g = ((g * 3 + gray * 7) / 10) * 92 / 100;
                    b = ((b * 3 + gray * 7) / 10) * 92 / 100;
                    a = a * 85 / 100;
                }
                let di = (oy as usize * dst_w as usize + ox as usize) * 4;
                // UpdateLayeredWindow 要求预乘 BGRA。
                dst[di] = ((b * a + 127) / 255) as u8;
                dst[di + 1] = ((g * a + 127) / 255) as u8;
                dst[di + 2] = ((r * a + 127) / 255) as u8;
                dst[di + 3] = a as u8;
            }
        }
    }

    unsafe fn commit_bitmap(
        &self,
        width: u32,
        height: u32,
        pixels: &mut [u8],
        bubble: Option<&BubbleSpec>,
    ) -> Result<(), String> {
        let screen_dc = GetDC(None);
        if screen_dc.0.is_null() {
            return Err("GetDC 失败".into());
        }
        let memory_dc = CreateCompatibleDC(Some(screen_dc));
        if memory_dc.0.is_null() {
            let _ = ReleaseDC(None, screen_dc);
            return Err("CreateCompatibleDC 失败".into());
        }

        let mut bitmap_info = BITMAPINFO::default();
        bitmap_info.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            // 负高度 = top-down,与 RGBA 源图行序一致。
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let bitmap = match CreateDIBSection(
            Some(screen_dc),
            &bitmap_info,
            DIB_RGB_COLORS,
            &mut bits,
            None,
            0,
        ) {
            Ok(bitmap) => bitmap,
            Err(e) => {
                let _ = DeleteDC(memory_dc);
                let _ = ReleaseDC(None, screen_dc);
                return Err(format!("CreateDIBSection 失败: {e}"));
            }
        };
        std::ptr::copy_nonoverlapping(pixels.as_ptr(), bits.cast::<u8>(), pixels.len());
        let old_bitmap = SelectObject(memory_dc, HGDIOBJ(bitmap.0));

        if let Some(bubble) = bubble {
            draw_bubble_text(memory_dc, bubble);
            // GDI 在 32-bit DIB 上画字时会把命中的 alpha 字节清零。
            // RGB 非零而 alpha 为零的像素只能来自这一步(精灵已预乘),补回
            // 不透明度，否则 layered window 上文字会变成镂空。
            let dib = std::slice::from_raw_parts_mut(bits.cast::<u8>(), pixels.len());
            for pixel in dib.chunks_exact_mut(4) {
                if pixel[3] == 0 && (pixel[0] != 0 || pixel[1] != 0 || pixel[2] != 0) {
                    pixel[3] = 255;
                }
            }
        }

        let size = SIZE {
            cx: width as i32,
            cy: height as i32,
        };
        let source = POINT { x: 0, y: 0 };
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let result = UpdateLayeredWindow(
            self.hwnd(),
            Some(screen_dc),
            None,
            Some(&size),
            Some(memory_dc),
            Some(&source),
            COLORREF(0),
            Some(&blend),
            ULW_ALPHA,
        )
        .map_err(|e| format!("UpdateLayeredWindow 失败: {e}"));

        SelectObject(memory_dc, old_bitmap);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(memory_dc);
        let _ = ReleaseDC(None, screen_dc);
        result
    }
}

struct BubbleSpec {
    rect: RECT,
    text: Vec<u16>,
    color: COLORREF,
    font_height: i32,
}

fn draw_bubble(
    pixels: &mut [u8],
    width: u32,
    height: u32,
    scale: f64,
    tone: Tone,
    text: &str,
) -> BubbleSpec {
    let logical_text = text
        .chars()
        .map(|c| if c.is_ascii() { 6.0 } else { 11.0 })
        .sum::<f64>();
    let bubble_w = ((logical_text + 18.0).clamp(42.0, 112.0) * scale).round() as i32;
    let bubble_h = (24.0 * scale).round().max(16.0) as i32;
    let radius = (9.0 * scale).round().max(4.0) as i32;
    let left = ((width as i32 - bubble_w) / 2).max(0);
    let top = 0;
    let right = (left + bubble_w).min(width as i32);
    let bottom = (top + bubble_h).min(height as i32);
    let (bg, fg) = match tone {
        Tone::Ok => ((5, 150, 105), (234, 255, 245)),
        Tone::Warn => ((161, 98, 7), (255, 247, 224)),
        Tone::Error => ((185, 52, 52), (255, 236, 236)),
        Tone::Normal => ((19, 19, 22), (216, 216, 222)),
    };

    for y in top..bottom {
        for x in left..right {
            if inside_rounded_rect(x, y, left, top, right, bottom, radius) {
                set_opaque_pixel(pixels, width, x, y, bg);
            }
        }
    }
    // 气泡尾巴。
    let tail_h = (4.0 * scale).round().max(2.0) as i32;
    let center = width as i32 / 2;
    for row in 0..tail_h {
        let half = (tail_h - row).max(1);
        for x in center - half..=center + half {
            let y = bottom + row;
            if x >= 0 && x < width as i32 && y >= 0 && y < height as i32 {
                set_opaque_pixel(pixels, width, x, y, bg);
            }
        }
    }

    let pad = (7.0 * scale).round().max(3.0) as i32;
    BubbleSpec {
        rect: RECT {
            left: left + pad,
            top,
            right: right - pad,
            bottom,
        },
        text: text.encode_utf16().collect(),
        color: rgb(fg.0, fg.1, fg.2),
        font_height: -((11.0 * scale).round().max(8.0) as i32),
    }
}

fn inside_rounded_rect(x: i32, y: i32, l: i32, t: i32, r: i32, b: i32, radius: i32) -> bool {
    let cx = if x < l + radius {
        l + radius
    } else if x >= r - radius {
        r - radius - 1
    } else {
        x
    };
    let cy = if y < t + radius {
        t + radius
    } else if y >= b - radius {
        b - radius - 1
    } else {
        y
    };
    let dx = x - cx;
    let dy = y - cy;
    dx * dx + dy * dy <= radius * radius
}

fn set_opaque_pixel(pixels: &mut [u8], width: u32, x: i32, y: i32, (r, g, b): (u8, u8, u8)) {
    let i = (y as usize * width as usize + x as usize) * 4;
    pixels[i] = b;
    pixels[i + 1] = g;
    pixels[i + 2] = r;
    pixels[i + 3] = 255;
}

unsafe fn draw_bubble_text(dc: windows::Win32::Graphics::Gdi::HDC, bubble: &BubbleSpec) {
    let font = CreateFontW(
        bubble.font_height,
        0,
        0,
        0,
        FW_NORMAL.0 as i32,
        0,
        0,
        0,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        ANTIALIASED_QUALITY,
        DEFAULT_PITCH.0 as u32,
        w!("Microsoft YaHei UI"),
    );
    if font.0.is_null() {
        return;
    }
    let old_font = SelectObject(dc, HGDIOBJ(font.0));
    SetBkMode(dc, TRANSPARENT);
    SetTextColor(dc, bubble.color);
    let mut rect = bubble.rect;
    let mut text = bubble.text.clone();
    DrawTextW(
        dc,
        &mut text,
        &mut rect,
        DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS | DT_NOPREFIX,
    );
    SelectObject(dc, old_font);
    let _ = DeleteObject(HGDIOBJ(font.0));
}

const fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
    COLORREF(r as u32 | ((g as u32) << 8) | ((b as u32) << 16))
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    ref_data: usize,
) -> LRESULT {
    let pet = &*(ref_data as *const NativePet);
    match msg {
        WM_RENDER => {
            pet.render(true);
            return LRESULT(0);
        }
        WM_TIMER if wparam.0 == TIMER_ID => {
            pet.render(false);
            return LRESULT(0);
        }
        WM_LBUTTONDOWN => {
            let mut cursor = POINT::default();
            let mut origin = RECT::default();
            if windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut cursor).is_ok()
                && GetWindowRect(hwnd, &mut origin).is_ok()
            {
                let mut mouse = pet.mouse.lock().unwrap();
                mouse.down = true;
                mouse.dragged = false;
                mouse.cursor = cursor;
                mouse.origin = origin;
                SetCapture(hwnd);
            }
            return LRESULT(0);
        }
        WM_MOUSEMOVE => {
            let mut mouse = pet.mouse.lock().unwrap();
            if mouse.down {
                let mut cursor = POINT::default();
                if windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut cursor).is_ok() {
                    let dx = cursor.x - mouse.cursor.x;
                    let dy = cursor.y - mouse.cursor.y;
                    if dx.abs() + dy.abs() > 4 {
                        mouse.dragged = true;
                    }
                    if mouse.dragged {
                        let _ = SetWindowPos(
                            hwnd,
                            None,
                            mouse.origin.left + dx,
                            mouse.origin.top + dy,
                            0,
                            0,
                            SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
                        );
                    }
                }
            }
            return LRESULT(0);
        }
        WM_LBUTTONUP => {
            let mut mouse = pet.mouse.lock().unwrap();
            let clicked = mouse.down && !mouse.dragged;
            mouse.down = false;
            let _ = ReleaseCapture();
            drop(mouse);
            if clicked {
                crate::show_any_window(&pet.app);
            }
            return LRESULT(0);
        }
        WM_NCDESTROY => {
            let _ = KillTimer(Some(hwnd), TIMER_ID);
            let _ = RemoveWindowSubclass(hwnd, SUBCLASSPROC::Some(window_proc), SUBCLASS_ID);
            let result = DefSubclassProc(hwnd, msg, wparam, lparam);
            drop(Arc::from_raw(ref_data as *const NativePet));
            return result;
        }
        _ => {}
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}
