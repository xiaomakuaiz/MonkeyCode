#include "RNOH/PackageProvider.h"
#include "RNOHPackagesFactory.h"          // autolinking 生成（DevEco Sync）
#include "generated/RNOHGeneratedPackage.h" // codegen 生成（应用自有 TurboModule 胶水）

using namespace rnoh;

std::vector<std::shared_ptr<Package>> PackageProvider::getPackages(
    Package::Context ctx) {
  auto packages = createRNOHPackages(ctx);
  packages.push_back(std::make_shared<RNOHGeneratedPackage>(ctx));
  return packages;
}
