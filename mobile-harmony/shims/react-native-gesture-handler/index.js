/**
 * react-native-gesture-handler stub（鸿蒙轨）。
 * 只被 @react-native-ohos/react-native-screens 的 ScreenGestureDetector 静态导入拖进
 * 依赖图；我们不启用 goBackGesture，运行时永远走 GHContext 默认的 passthrough，
 * 这些导出不会被真正调用。如后续需要真手势库，换 @react-native-ohos/react-native-gesture-handler。
 */
function chainable() {
  const f = function () {
    return f;
  };
  return new Proxy(f, {
    get: (_t, p) => (p === Symbol.toPrimitive || p === 'toString' ? () => '' : chainable()),
  });
}

const passthrough = ({ children }) => children ?? null;

const known = {
  __esModule: true,
  GestureDetector: passthrough,
  GestureHandlerRootView: passthrough,
  default: {},
};

module.exports = new Proxy(known, {
  get: (t, p) => (p in t ? t[p] : chainable()),
});
