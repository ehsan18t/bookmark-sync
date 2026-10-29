import { APP_NAME } from '../../config.js';
import { Icon } from './Icon.js';

export function Brand() {
  return (
    <div class="brand">
      <Icon name="bookmarks" />
      {APP_NAME}
    </div>
  );
}
