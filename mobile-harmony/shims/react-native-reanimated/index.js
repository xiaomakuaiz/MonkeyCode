/**
 * react-native-reanimated stub（鸿蒙轨）。
 * 业务代码零引用；只被 @react-native-ohos/react-native-screens 的手势检测文件静态导入
 * （我们不启用 goBackGesture，运行时不会调用）。如后续真要 reanimated，
 * 需评估 @react-native-oh-tpl/react-native-reanimated 的 0.82 适配。
 */
function chainable() {
  // 调用必须返回 Proxy 本身而非裸函数 f，否则链式调用在第二跳断掉（同 gesture-handler shim）
  const f = function () {
    return p;
  };
  const p = new Proxy(f, {
    get: (_t, prop) => (prop === Symbol.toPrimitive || prop === 'toString' ? () => '' : chainable()),
  });
  return p;
}

const known = {
  __esModule: true,
  useSharedValue: (v) => ({ value: v }),
  useAnimatedRef: () => ({ current: null }),
  useAnimatedStyle: () => ({}),
  useDerivedValue: (fn) => ({ value: typeof fn === 'function' ? undefined : fn }),
  measure: () => null,
  runOnJS: (fn) => fn,
  runOnUI: (fn) => fn,
  withTiming: (v) => v,
  withSpring: (v) => v,
  interpolate: () => 0,
  default: {},
};

module.exports = new Proxy(known, {
  get: (t, p) => (p in t ? t[p] : chainable()),
});
