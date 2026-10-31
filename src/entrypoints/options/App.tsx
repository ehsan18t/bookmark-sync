import { Banner } from '../../ui/components/Banner.js';
import { failure, ready } from '../../ui/state/boot.js';
import { refreshError } from '../../ui/state/store.js';
import { Dashboard } from './dashboard/Dashboard.js';
import { isTab } from './dashboard/tabs.js';
import { finishSetup, hash, inSetup } from './route.js';
import { Setup } from './setup/Setup.js';

export function App() {
  if (failure.value)
    return (
      <div class="page">
        <Banner kind="danger" icon="alert-triangle">
          {failure.value}
        </Banner>
      </div>
    );
  if (!ready.value) return null;
  return (
    <>
      {refreshError.value && (
        <div class="page">
          <Banner kind="danger" icon="alert-triangle">
            {refreshError.value} What you see may be out of date.
          </Banner>
        </div>
      )}
      {hash.value === 'setup' || (inSetup.value && hash.value !== 'about') ? <Setup onFinish={finishSetup} /> : <Dashboard tab={isTab(hash.value) ? hash.value : 'overview'} />}
    </>
  );
}
