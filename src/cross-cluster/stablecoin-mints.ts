/**
 * USD stablecoin mints (Solana mainnet-beta) that must not be admitted as a v2.2 market UNDERLYING.
 *
 * SOURCE OF TRUTH: percolator-launch app/lib/v22/stablecoin-mints.ts. This is a copy of its 52 mainnet
 * entries (32 from 2026-11-10 + 7 added 2026-11-11 with percolator-launch #3798 + 2 added in r8: Solayer sUSD, Maple syrupUSDC + 11 added in the r8 Council
 * finding: USDu, sUSDu, USDGO, USDP, sUSDai, USDv, DUSD, wYLDS, PST, XO, SOFID); when that
 * list changes, update this file in lockstep. The keeper has NO ticker/name rule: it is mint-only, so BOLD / USX / CASH are only ever blocked
 * by their verified mint (USX, CASH are listed; Liquity BOLD has no Solana mint).
 * Policy: USD-pegged stablecoins incl. bridged (Portal/Allbridge) and yield-bearing USD (sUSDe, USDY, sUSD, syrupUSDC, sUSDu, sUSDai, wYLDS, PST);
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
  // Added 2026-11-11 (r8). getAccountInfo on the Solana public RPC + issuer docs page + Jupiter (verified, yb) + CoinGecko platforms.solana.
  ["susdabGDNbhrnCa6ncrYo81u4s9GM8ecK2UwMyZiq4X", "sUSD"], // ISSUER docs.solayer.org (sUSD Token Info); CG solayer-usd; JUP verified yb; Token-2022 metadata Solayer USD / sUSD
  ["AvZZF1YaZDziPY2RCK4oJrRVrbN3mTD9NL24hPeaZeUj", "syrupUSDC"], // ISSUER docs.maple.finance crosschain (Solana token); CG syrupusdc; JUP verified yb
  // Added 2026-11-11 (r8 Council finding). getAccountInfo on the Solana public RPC + Jupiter tokens v2 + issuer docs page or CoinGecko platforms.solana (full sources in the launch list).
  ["9ckR7pPPvyPadACDTzLwK2ZAEeUJ3qGSnzPs8bVaHrSy", "USDu"], // ISSUER docs.unitas.so (General Overview, official token table, Solana); CG usdu; JUP stable (verified); CHAIN Token-2022 metadata USDu / USDu
  ["9iq5Q33RSiz1WcupHAQKbHBZkpn92UxBG2HfPWAZhMCa", "sUSDu"], // ISSUER docs.unitas.so (General Overview, official token table, Solana); JUP verified; CHAIN Token-2022 metadata Staked USDu / sUSDu
  ["72puLt71H93Z9CzHuBRTwFpL4TG3WZUhnoCC7p8gxigu", "USDGO"], // CG usdgo; JUP verified; CHAIN Token-2022 metadata USDGO / USDGO; Solflare / Bitget / Solana Compass list it as the official Solana mint
  ["HVbpJAQGNpkgBaYBZQBR1t7yFdvaYVp2vCQQfKKEN4tM", "USDP"], // ISSUER docs.paxos.com/guides/stablecoin/usdp/mainnet (Solana Mainnet Beta); CG paxos-standard; JUP strict; CHAIN Token-2022 metadata Pax Dollar / USDP
  ["sUSDai6Y3GxysDEtA9BVcEFTaog6UZpYUVxJiMhAKYE", "sUSDai"], // ISSUER docs.usd.ai Contract Addresses page (Solana table, sUSDai OFT); JUP verified; CHAIN Token-2022 metadata Staked USDai / sUSDai
  ["USDvUSpnhCr9yBgj3UyVrD239HRUv4RsHwH2FxsWuMk", "USDv"], // CG solomon-usdv; JUP verified; CHAIN Token-2022 metadata USDv / USDv; Solana Compass news on the Sunrise launch names this mint canonical
  ["DUSDt4AeLZHWYmcXnVGYdgAzjtzU5mXUVnTMdnSzAttM", "DUSD"], // CG standx-dusd; JUP stable (verified); CHAIN Token-2022 metadata DUSD / DUSD
  ["8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih", "wYLDS"], // CG hastra-wrapped-ylds; JUP stable (verified); CHAIN SPL mint (6 decimals); Phantom / Solana Compass list it as Hastra wYLDS
  ["59obFNBzyTBGowrkif5uK7ojS58vsuWz3ZCvg6tfZAGw", "PST"], // CG payfi-strategy-token-usdc; JUP verified yb; CHAIN SPL mint (6 decimals)
  ["xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y", "XO"], // CG xo-cash; JUP verified; CHAIN Token-2022 metadata XO Cash / XO; Solflare lists it as the official Solana contract
  ["APhcqtzE73es3KAGiVksZFMLGwJDiAey5qZKUrQHEHfS", "SOFID"], // CG sofiusd platforms.solana; JUP verified; CHAIN Token-2022 metadata SoFiUSD / SOFID; The Block / Decrypt report the Solana launch
]);

export function isStablecoinMint(mint: string | null | undefined): boolean {
  return typeof mint === "string" && STABLECOIN_MINTS.has(mint);
}
