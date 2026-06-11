/**
 * react-native-quick-crypto stub：基于 nitro-modules，无鸿蒙适配。
 * 导出空对象 → 主轨 sha256fast.ts 的守卫式 require 检测不到 createHash，
 * 自动回退 @noble/hashes 纯 JS 实现（PoW 验证码慢一些但可用）。
 * TODO：如登录验证码耗时不可接受，可在 MonkeyCodeNative 里加原生 sha256。
 */
export default {};
