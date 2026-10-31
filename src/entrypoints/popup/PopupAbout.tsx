import { APP_NAME } from '../../config.js';
import { Icon } from '../../ui/components/Icon.js';
import { ABOUT_LINKS, manifestInfo } from '../../ui/lib/about.js';
import { openPage } from './openPage.js';

const SHOWN = new Set(['web', 'privacy', 'source']);

interface PopupAboutProps {
  onBack: () => void;
}

export function PopupAbout({ onBack }: PopupAboutProps) {
  const { version, description } = manifestInfo();
  return (
    <>
      <div class="popup-head">
        <button type="button" class="ghost" onClick={onBack}>
          <Icon name="arrow-left" />
          Back
        </button>
      </div>
      <div class="popup-card stack center">
        <div class="done-mark invite">
          <Icon name="bookmarks" class="lg" />
        </div>
        <div class="stack tight center">
          <b>{APP_NAME}</b>
          <span class="muted small">Version {version}</span>
        </div>
        {description && <p class="muted small">{description}</p>}
      </div>
      {ABOUT_LINKS.some((l) => SHOWN.has(l.key)) && (
        <div class="popup-card popup-links">
          {ABOUT_LINKS.filter((l) => SHOWN.has(l.key)).map((l) => (
            <a key={l.key} href={l.href} target="_blank" rel="noopener">
              {l.title}
              <Icon name="external-link" />
            </a>
          ))}
        </div>
      )}
      <div class="popup-foot">
        <button type="button" class="ghost" onClick={openPage('about')}>
          <Icon name="info-circle" />
          More details
        </button>
      </div>
    </>
  );
}
