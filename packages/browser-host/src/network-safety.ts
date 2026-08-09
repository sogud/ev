import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const BLOCKED_IPV4_ADDRESSES = new BlockList();
const BLOCKED_IPV6_ADDRESSES = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_IPV4_ADDRESSES.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_IPV6_ADDRESSES.addSubnet(address, prefix, 'ipv6');
}

export type AddressResolver = (hostname: string) => Promise<string[]>;

export const defaultAddressResolver: AddressResolver = async hostname =>
  (await lookup(hostname, { all: true, verbatim: true })).map(item => item.address);

export async function resolvePublicAddresses(
  hostnameValue: string,
  resolveAddresses: AddressResolver
): Promise<string[]> {
  const hostname = hostnameValue.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Media URL resolves to a local or private network');
  }
  const addresses = isIP(hostname) ? [hostname] : await resolveAddresses(hostname);
  if (
    addresses.length === 0 ||
    addresses.some(address => {
      const family = isIP(address);
      return (
        family === 0 ||
        (family === 6
          ? BLOCKED_IPV6_ADDRESSES.check(address, 'ipv6')
          : BLOCKED_IPV4_ADDRESSES.check(address, 'ipv4'))
      );
    })
  ) {
    throw new Error('Media URL resolves to a local or private network');
  }
  return addresses;
}
