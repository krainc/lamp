import { VirtualAdapter } from './virtual.js';
import { ShellyMqttAdapter } from './shelly-mqtt.js';
import { TasmotaMqttAdapter } from './tasmota-mqtt.js';
import { SonoffEwelinkAdapter } from './sonoff-ewelink.js';
import { KasaAdapter } from './kasa.js';
import { TuyaAdapter } from './tuya.js';

/**
 * Adapter registry. Add hardware here; `lamp.adapter` in config.json is a key
 * of this object.
 */
export const ADAPTERS = {
  virtual: VirtualAdapter,
  'shelly-mqtt': ShellyMqttAdapter,
  'tasmota-mqtt': TasmotaMqttAdapter,
  'sonoff-ewelink': SonoffEwelinkAdapter,
  kasa: KasaAdapter,
  tuya: TuyaAdapter,
};

/** Adapters that share one cloud connection rather than talking to our broker. */
export const EWELINK_ADAPTERS = new Set(['sonoff-ewelink']);

export function createAdapter({ lamp, ctx, report }) {
  const Adapter = ADAPTERS[lamp.adapter];
  if (!Adapter) {
    throw new Error(
      `lamp ${lamp.id}: unknown adapter "${lamp.adapter}". ` +
        `Available: ${Object.keys(ADAPTERS).join(', ')}`,
    );
  }
  return new Adapter({ lampId: lamp.id, options: lamp.options, ctx, report });
}
