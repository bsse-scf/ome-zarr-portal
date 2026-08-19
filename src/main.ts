import './ui/styles.css';
import { installPreviewHost } from './preview/host';
import { startApp } from './ui/app';

// The service worker delegates preview rendering to this page; see
// `src/preview/host.ts` for why it cannot do the work itself.
installPreviewHost();
startApp();
