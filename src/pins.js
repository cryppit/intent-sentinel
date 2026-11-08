// The latest day pinned on NEAR, shown as a badge on the page. Its packets are saved in pins/<day>, and a test checks
// that they still give this root, so the badge can't drift from what was pinned.
export const LATEST_PIN = {
  day: "2026-11-06",
  account: "sentinel.cryppit.testnet",
  network: "testnet",
  tx: "GW6MLNNSiztTC11haCkzyK2wy62JwtRKsu2zbh6gdAi9",
  root: "88c6743c2cfa00d7bfd01a34b24dd59a7142deac90159b46d57118914671ccae",
  cases: 3,
};
const EXPLORER = { testnet: "https://explorer.testnet.near.org", mainnet: "https://explorer.near.org" };
export const pinUrl = (pin) => `${EXPLORER[pin.network]}/transactions/${pin.tx}`;
