import { signal } from '@preact/signals';
import { render } from 'preact';
import { Banner } from '../../ui/components.js';
import { errorText } from '../../ui/dom.js';
import '../../ui/styles.css';
import { Dashboard, isTab } from './Dashboard.js';
import { Setup } from './Setup.js';
import { groups, load } from './shared.js';

const hash = signal(location.hash.slice(1));
const ready = signal(false);
const failure = signal('');

window.addEventListener('hashchange', () => (hash.value = location.hash.slice(1)));

function App() {
  if (failure.value)
    return (
      <div class="page">
        <Banner kind="danger" icon="alert-triangle">
          {failure.value}
        </Banner>
      </div>
    );
  if (!ready.value) return null;
  if (hash.value === 'setup' || !groups.value.length) return <Setup key={hash.value} onFinish={() => (location.hash = 'overview')} />;
  return <Dashboard tab={isTab(hash.value) ? hash.value : 'overview'} />;
}

render(<App />, document.getElementById('app')!);

load().then(
  () => (ready.value = true),
  (e) => (failure.value = errorText(e)),
);

setInterval(() => {
  if (document.visibilityState === 'visible' && hash.value !== 'setup') void load().catch(() => {});
}, 5000);
