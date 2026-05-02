export { Adapter, AdapterConfig } from './types';
export { AdbAdapter } from './adb';
export { IosAdapter } from './ios';
export { TizenAdapter } from './tizen';
export { SerialAdapter, SerialAdapterConfig } from './serial';
export { LinuxAdapter } from './linux';
export { WindowsAdapter } from './windows';
export { MacosAdapter } from './macos';

// This acts as the formalized Adapter SDK entrypoint.
// Community developers can build custom adapters matching the `Adapter` interface.

export function getAdapterInstance(adapterName: string): any {
    switch (adapterName.toLowerCase()) {
        case 'windows': return new (require('./windows').WindowsAdapter)();
        case 'macos': return new (require('./macos').MacosAdapter)();
        case 'linux': return new (require('./linux').LinuxAdapter)();
        case 'simctl': return new (require('./ios').IosAdapter)();
        case 'sdb': return new (require('./tizen').TizenAdapter)();
        case 'android':
        case 'adb':
        case 'tdb': // Test Debug Bridge (mock adb)
        case 'hdc':
        default:
            return new (require('./adb').AdbAdapter)();
    }
}
