#include "RNOH/PackageProvider.h"
#include "RNOHPackagesFactory.h"          // autolinking 生成（DevEco Sync）
// codegen 生成（应用自有 TurboModule 胶水，cli 0.82 新结构，见 CMakeLists 的 include dir）
#include "RNOH/generated/BaseMonkeycodeMobileHarmonyPackage.h"
// 手动接入的三方库（har 无 autolinking 元数据，link-harmony 跳过，见 CMakeLists.txt）
#include "ClipboardPackage.h"
#include "SafeAreaViewPackage.h"
#include "ScreensPackage.h"
#include "SVGPackage.h"
#include "WebViewPackage.h"
#include "RNImagePickerPackage.h"

using namespace rnoh;

std::vector<std::shared_ptr<Package>> PackageProvider::getPackages(
    Package::Context ctx) {
  auto packages = createRNOHPackages(ctx);
  packages.push_back(std::make_shared<BaseMonkeycodeMobileHarmonyPackage>(ctx));
  packages.push_back(std::make_shared<ClipboardPackage>(ctx));
  packages.push_back(std::make_shared<SafeAreaViewPackage>(ctx));
  packages.push_back(std::make_shared<ScreensPackage>(ctx));
  packages.push_back(std::make_shared<SVGPackage>(ctx));
  packages.push_back(std::make_shared<WebViewPackage>(ctx));
  packages.push_back(std::make_shared<RNImagePickerPackage>(ctx));
  return packages;
}
