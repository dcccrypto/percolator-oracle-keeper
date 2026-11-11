/**
 * USD stablecoin mints (Solana mainnet-beta) that must not be admitted as a v2.2 market UNDERLYING.
 *
 * SOURCE OF TRUTH: percolator-launch app/lib/v22/stablecoin-mints.ts. This is a verbatim copy of the
 * 32 mainnet entries (generated 2026-11-10); when that list changes, update this file in lockstep.
 * Policy: USD-pegged stablecoins incl. bridged (Portal/Allbridge) and yield-bearing USD (sUSDe, USDY);
 * EURC and non-USD fiat stables excluded.
 */
export const STABLECOIN_MINTS: ReadonlyMap<string, string> = new Map<string, string>([
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "USDC"],
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "USDT"],
  ["2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", "PYUSD"],
  ["USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA", "USDS"],
  ["9zNQRsGLjNKwCUU5Gq5LR8beUCPzQMVMqKAi3SSZh54u", "FDUSD"],
  ["DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT", "USDe"],
  ["Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN", "sUSDe"],
  ["2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH", "USDG"],
  ["USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB", "USD1"],
  ["AUSD1jCcCyPLybk1YnvPWsHQSrZ46dxwoMniN4N2UEB9", "AUSD"],
  ["A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6", "USDY"],
  ["USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX", "USDH"],
  ["7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT", "UXD"],
  ["5YMkXAYccHSGnHn9nob9xEvv6Pvka9DZWH7nTbotTu9E", "hyUSD"],
  ["GzX1ireZDU865FiMaKrdVB1H6AE8LAqWYCg6chrMrfBw", "frxUSD"],
  ["EjmyN6qEC1Tf1JxiG1ae7UTJhUxSwk1TCWNWqxWV4J6o", "DAI"],
  ["A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM", "USDCet"],
  ["Dn4noZ5jgGfkntzcQSUZ8czkreiZ1ForXYoV2H8Dm7S1", "USDTet"],
  ["E2VmbootbVCBkMNNxKQgCLMS1X3NoGMaYAsufaAsf7M", "USDCpo"],
  ["5goWRao6a3yNC4d6UjMdQxonkCMvKBwdpubU3qhfcdf1", "USDTpo"],
  ["FCqfQSujuPxy6V42UvafBhsysWtEq1vhjfMN1PUbgaxA", "USDCbs"],
  ["8qJSyQprMC57TWKaYEmetUR3UUiTP2M3hXdcvFhkZdmv", "USDTbs"],
  ["9vMJfxuKxXBoEa7rM12mYLMwTacLMLDJqHozw96WQL8i", "UST"],
  ["DdFPRnccQqLD4zCHrBqdY95D6hvw6PLWp9DEXj1fLCL9", "aeUSDC"],
  ["eqKJTf1Do4MDPyKisMYqVaUFpkEFAs3riGF3ceDH2Ca", "apUSDC"],
  ["8XSsNvaKU9FDhYWAv7Yc7qSNwuJSzVrXBNEk7AFiWF69", "abUSDC"],
  ["8Yv9Jz4z7BUHP68dz8E8m3tMe6NKgpMUKn8KVqrPA6Fr", "aaUSDC"],
  ["DHpoYejUDqzByb6HAdaLWF7KZvwUv2vWYDY9cTENNZui", "acUSDC"],
  ["Bn113WT6rbdgwrm12UJtnmNqGqZjY4it2WoUQuQopFVn", "aeUSDT"],
  ["DNhZkUaxHXYvpxZ7LNnHtss8sQgdAfd1ZYS1fB7LKWUZ", "apUSDT"],
  ["E77cpQ4VncGmcAXX16LHFFzNBEBb2U7Ar7LBmZNfCgwL", "abUSDT"],
  ["FwEHs3kJEdMa2qZHv7SgzCiFXUQPEycEXksfBkwmS8gj", "aaUSDT"],
  // Added 2026-11-11 (r7). Verified read-only: Solana public RPC getAccountInfo (SPL / Token-2022 mint) + on-chain metadata name/symbol + an
  // independent source (CG = CoinGecko platforms.solana, JUP = Jupiter token search verified/stable tag, SLTL = solana-labs token list).
  ["usdsfJbX78ktZUnoRC7dwvvQz7xH3WdkpGne76gdUia", "USD+"], // CG usd-2; JUP verified; Metaplex USD+
  ["CASHx9KJUStyftLFWGvEVf59SGeG9sh5FfcnZMVPCASH", "CASH"], // CG cash-4; JUP stable; Token-2022 metadata CASH
  ["6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG", "USX"], // CG usx; JUP stable; Metaplex USX
  ["3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC", "eUSX"], // CG solstice-eusx; JUP verified (yield-bearing); Metaplex eUSX
  ["JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD", "JupUSD"], // CG jupusd; JUP stable; Metaplex JupUSD
  ["EwxNF8g9UfmsJVcZFTpL9Hx5MCkoQFoJi6XNWzKf1j8e", "acUSD"], // SLTL acUSD (Allbridge, Celo cUSD); mint account verified on-chain
  ["FR87nWEUxVgerFGhZM8Y4AggKGLnaXswr1Pd8wZ4kZcp", "FRAX"], // SLTL FRAX (Portal); Metaplex Frax (Wormhole) / FRAX
]);

export function isStablecoinMint(mint: string | null | undefined): boolean {
  return typeof mint === "string" && STABLECOIN_MINTS.has(mint);
}
