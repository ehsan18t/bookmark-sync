import { render } from 'preact';
import { APP_NAME } from '../../config.js';
import { boot } from '../../ui/state/boot.js';
import '../../ui/styles/common.css';
import './popup.css';
import { Popup } from './Popup.js';

document.title = APP_NAME;

render(<Popup />, document.getElementById('app')!);
boot();
