import { effect, signal } from '@preact/signals';
import { render } from 'preact';
import { Banner } from '../../ui/components.js';
import { errorText } from '../../ui/util.js';
import '../../ui/styles.css';
import { Dashboard, isTab } from './Dashboard.js';
import { Setup } from './Setup.js';
import { follow, groups, load } from './shared.js';

const hash = signal(location.hash.slice(1));
const ready = signal(false);
const failure = signal('');
/** Setup keeps the page until it finishes, even once its own reload shows a sync. */
const inSetup = signal(false);

const finish = () => {
  inSetup.value = false;
  location.hash = 'overview';
};

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
  if (hash.value === 'setup' || inSetup.value) return <Setup onFinish={finish} />;
  return <Dashboard tab={isTab(hash.value) ? hash.value : 'overview'} />;
}

render(<App />, document.getElementById('app')!);

effect(() => {
  if (ready.value && !groups.value.length) inSetup.value = true;
});

/** The saved snapshot draws the page at once; the fresh load only has to be waited for when nothing is saved. */
async function start() {
  if (await follow()) {
    ready.value = true;
    void load().catch(() => {});
  } else {
    await load();
    ready.value = true;
  }
}

start().catch((e) => (failure.value = errorText(e)));
