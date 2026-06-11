/**
 * 鸿蒙轨入口：appKey 必须与 harmony/entry/src/main/ets/pages/Index.ets 里 RNApp 的
 * appKey 一致（'MonkeyCode'）。
 */
import { AppRegistry } from 'react-native';
import App from './src/App';

AppRegistry.registerComponent('MonkeyCode', () => App);
