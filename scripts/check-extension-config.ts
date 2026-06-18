import { checkPortCompatibility } from '../src/acceptance/portCompatibility.js';

const details = checkPortCompatibility(process.cwd(), process.env.TABATLAS_SERVER_URL);

console.log(`Server URL: ${details.serverUrl}`);
console.log(`Server default port: ${details.serverDefaultPort}`);
console.log(`Extension receivers: ${details.receivers.join(', ') || '(none)'}`);
console.log(`Manifest host permissions: ${details.hostPermissions.join(', ') || '(none)'}`);
console.log(`Popup default receiver: ${details.popupDefaultReceiver || '(none)'}`);

if (details.issues.length) {
  console.error('Port compatibility failed:');
  for (const issue of details.issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log('Port compatibility passed.');
