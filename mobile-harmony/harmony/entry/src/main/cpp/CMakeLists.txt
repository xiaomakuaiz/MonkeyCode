cmake_minimum_required(VERSION 3.11)
project(monkeycode)

set(RNOH_APP_DIR "${CMAKE_CURRENT_SOURCE_DIR}")
set(NODE_MODULES "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../node_modules")
set(RNOH_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../oh_modules/@rnoh/react-native-openharmony/src/main/cpp")
set(RNOH_GENERATED_DIR "${CMAKE_CURRENT_SOURCE_DIR}/generated")
set(LOG_VERBOSITY_LEVEL 1)
set(CMAKE_ASM_FLAGS "-Wno-error=unused-command-line-argument -Qunused-arguments")
set(CMAKE_CXX_FLAGS "-fstack-protector-strong -Wl,-z,relro,-z,now,-z,noexecstack -s -fPIE -pie")
set(WITH_HITRACE_SYSTRACE ON)
set(WITH_HITRACE_REACT_MARKER ON)
# autolinking（autolink_libraries）需要
set(OH_MODULES_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../../../oh_modules")

add_subdirectory("${RNOH_CPP_DIR}" ./rn)

# DevEco Sync 时由 link-harmony 生成（含三方库的 add_subdirectory / 链接）
include("${CMAKE_CURRENT_SOURCE_DIR}/autolinking.cmake")

# codegen 产物（应用自有 TurboModule 的胶水）。
# cli 0.82 的 codegen-harmony 输出在 generated/monkeycode_mobile_harmony/ 子树
# （RNOH/generated/turbo_modules/*.cpp + react/renderer/components/...），需递归收集
file(GLOB_RECURSE GENERATED_CPP_FILES "${CMAKE_CURRENT_SOURCE_DIR}/generated/*.cpp")

add_library(rnoh_app SHARED
    ${GENERATED_CPP_FILES}
    "./PackageProvider.cpp"
    "${RNOH_CPP_DIR}/RNOHAppNapiBridge.cpp"
)
# codegen 头文件按 "RNOH/generated/..." 与 "react/renderer/components/..." 相对引用
target_include_directories(rnoh_app PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/generated/monkeycode_mobile_harmony")
target_link_libraries(rnoh_app PUBLIC rnoh)

autolink_libraries(rnoh_app)

# 手动接入的三方库：这些 har 的 package.json 缺 harmony.autolinking 元数据，
# link-harmony 会跳过（[skip]），需在此处 + oh-package.json5 + PackageProvider.cpp/.ets 手动接线
add_subdirectory("${OH_MODULES_DIR}/@react-native-ohos/clipboard/src/main/cpp" ./rnoh_clipboard)
add_subdirectory("${OH_MODULES_DIR}/@react-native-ohos/react-native-safe-area-context/src/main/cpp" ./rnoh_safe_area)
add_subdirectory("${OH_MODULES_DIR}/@react-native-ohos/react-native-screens/src/main/cpp" ./rnoh_screens)
add_subdirectory("${OH_MODULES_DIR}/@react-native-ohos/react-native-svg/src/main/cpp" ./rnoh_svg)
add_subdirectory("${OH_MODULES_DIR}/@react-native-ohos/react-native-webview/src/main/cpp" ./rnoh_webview)
add_subdirectory("${OH_MODULES_DIR}/@react-native-ohos/react-native-image-picker/src/main/cpp" ./rnoh_image_picker)
target_link_libraries(rnoh_app PUBLIC
    rnoh_clipboard
    rnoh_safe_area
    rnoh_screens
    rnoh_svg
    rnoh_webview
    rnoh_image_picker
)
