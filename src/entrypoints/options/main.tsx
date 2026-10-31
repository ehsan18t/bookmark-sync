import { effect } from '@preact/signals';
import { render } from 'preact';
import { boot, ready } from '../../ui/state/boot.js';
import { groups } from '../../ui/state/store.js';
import '../../ui/styles/common.css';
import './setup/setup.css';
import './folder-picker/folder-picker.css';
import './dashboard/dashboard.css';
import { App } from './App.js';
import { followHash, hash, inSetup } from './route.js';

followHash();
render(<App />, document.getElementById('app')!);

// About opens from the popup before any sync exists; every other page goes to setup until then.
effect(() => {
  if (ready.value && !groups.value.length && hash.value !== 'about') inSetup.value = true;
});

boot();
