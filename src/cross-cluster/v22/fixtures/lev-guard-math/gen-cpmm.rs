const BPS: u128 = 10_000;
pub fn cpmm_dump_bps(r: u64, q: u64) -> u16 {
    if q == 0 { return 0; }
    if r == 0 { return 10_000; }
    let den = r as u128 + q as u128;
    let ratio = (r as u128) * 1_000_000_000 / den;
    let kept_bps = ratio * ratio / 100_000_000_000_000;
    (BPS - kept_bps) as u16
}
fn main() {
    let mut s: u64 = 0x9E3779B97F4A7C15;
    let mut next = || { s ^= s << 13; s ^= s >> 7; s ^= s << 17; s };
    let edges: [u64; 12] = [0,1,2,3,999_999_999,1_000_000_000,u64::MAX,u64::MAX-1,u64::MAX/2,u64::MAX/2+1,1<<32,10_000];
    let mut v: Vec<(u64,u64)> = vec![];
    for &a in &edges { for &b in &edges { v.push((a,b)); } }
    while v.len() < 24_000 {
        let k = next() % 4;
        let a = match k { 0 => next(), 1 => next() >> (next()%64), 2 => edges[(next()%12) as usize], _ => next() % 1000 };
        let k2 = next() % 4;
        let b = match k2 { 0 => next(), 1 => next() >> (next()%64), 2 => a.wrapping_add(next()%3).wrapping_sub(1), _ => next() % 1000 };
        v.push((a,b));
    }
    for (r,q) in v { println!("{} {} {}", r, q, cpmm_dump_bps(r,q)); }
}
