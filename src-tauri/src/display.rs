//! macOS display options the page follows. WebKit doesn't report Reduce transparency to the page, so it asks here.

use tauri::AppHandle;

#[cfg(target_os = "macos")]
pub fn reduce_transparency() -> bool {
    objc2_app_kit::NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceTransparency()
}

#[cfg(not(target_os = "macos"))]
pub fn reduce_transparency() -> bool {
    false
}

/// Tells the page whenever the person changes a display option in System Settings.
#[cfg(target_os = "macos")]
pub fn watch(app: AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSWorkspace, NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification};

    let changed = RcBlock::new(move |_| crate::wire::changed(&app, crate::wire::Topic::Display, ""));
    // SAFETY: the name is an AppKit constant, the block only captures a Send AppHandle, and a None queue runs it on
    // the posting thread.
    let observer = unsafe {
        NSWorkspace::sharedWorkspace().notificationCenter().addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification),
            None,
            None,
            &changed,
        )
    };
    // The observer lives as long as the app; dropping it would stop the notifications.
    std::mem::forget(observer);
}

#[cfg(not(target_os = "macos"))]
pub fn watch(_app: AppHandle) {}
