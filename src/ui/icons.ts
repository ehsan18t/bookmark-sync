import brandGoogleDrive from '@tabler/icons/outline/brand-google-drive.svg?raw';
import server from '@tabler/icons/outline/server.svg?raw';
import bookmarks from '@tabler/icons/outline/bookmarks.svg?raw';
import chevronRight from '@tabler/icons/outline/chevron-right.svg?raw';
import check from '@tabler/icons/outline/check.svg?raw';
import cloudUpload from '@tabler/icons/outline/cloud-upload.svg?raw';
import refresh from '@tabler/icons/outline/refresh.svg?raw';
import alertTriangle from '@tabler/icons/outline/alert-triangle.svg?raw';
import lock from '@tabler/icons/outline/lock.svg?raw';
import history from '@tabler/icons/outline/history.svg?raw';
import devices from '@tabler/icons/outline/devices.svg?raw';
import copy from '@tabler/icons/outline/copy.svg?raw';
import settings from '@tabler/icons/outline/settings.svg?raw';
import layoutDashboard from '@tabler/icons/outline/layout-dashboard.svg?raw';
import folder from '@tabler/icons/outline/folder.svg?raw';
import folders from '@tabler/icons/outline/folders.svg?raw';
import arrowLeft from '@tabler/icons/outline/arrow-left.svg?raw';
import plus from '@tabler/icons/outline/plus.svg?raw';
import circleCheck from '@tabler/icons/outline/circle-check.svg?raw';
import playerPause from '@tabler/icons/outline/player-pause.svg?raw';
import cloud from '@tabler/icons/outline/cloud.svg?raw';
import shieldLock from '@tabler/icons/outline/shield-lock.svg?raw';
import externalLink from '@tabler/icons/outline/external-link.svg?raw';
import trash from '@tabler/icons/outline/trash.svg?raw';
import logout from '@tabler/icons/outline/logout.svg?raw';
import loader2 from '@tabler/icons/outline/loader-2.svg?raw';
import infoCircle from '@tabler/icons/outline/info-circle.svg?raw';
import gitMerge from '@tabler/icons/outline/git-merge.svg?raw';
import replace from '@tabler/icons/outline/replace.svg?raw';
import clock from '@tabler/icons/outline/clock.svg?raw';
import x from '@tabler/icons/outline/x.svg?raw';
import world from '@tabler/icons/outline/world.svg?raw';

const icons = { 'brand-google-drive': brandGoogleDrive, server, bookmarks, 'chevron-right': chevronRight, check, 'cloud-upload': cloudUpload, refresh, 'alert-triangle': alertTriangle, lock, history, devices, copy, settings, 'layout-dashboard': layoutDashboard, folder, folders, 'arrow-left': arrowLeft, plus, 'circle-check': circleCheck, 'player-pause': playerPause, cloud, 'shield-lock': shieldLock, 'external-link': externalLink, trash, logout, 'loader-2': loader2, 'info-circle': infoCircle, 'git-merge': gitMerge, replace, clock, x, world };

export type IconName = keyof typeof icons;

export function icon(name: IconName, cls = ''): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `icon ${cls}`.trim();
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = icons[name];
  return span;
}
