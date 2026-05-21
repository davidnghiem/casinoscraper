const RTP_TOLERANCE_PP = 0.5;
const SITE_ORDER = ['shuffle', 'stake', 'rainbet', 'roobet'];

export function computeGate(results) {
  const listed = SITE_ORDER.filter((s) => results[s]?.found);
  const rtps = SITE_ORDER
    .filter((s) => results[s]?.found && typeof results[s]?.rtp === 'number')
    .map((s) => ({ site: s, rtp: results[s].rtp }));

  if (listed.length === 0) {
    return {
      verdict: 'escalate',
      icon: '⚠️',
      summary:
        'Not offered by any competitor → Escalate to Enhanced Due Diligence'
    };
  }

  if (rtps.length >= 2) {
    const max = Math.max(...rtps.map((x) => x.rtp));
    const min = Math.min(...rtps.map((x) => x.rtp));
    const variance = max - min;
    if (variance > RTP_TOLERANCE_PP) {
      const detail = rtps
        .map((x) => `${x.site}=${x.rtp.toFixed(2)}%`)
        .join(', ');
      return {
        verdict: 'reject',
        icon: '❌',
        summary: `RTP mismatch (Δ ${variance.toFixed(
          2
        )}pp — ${detail}) → Do NOT proceed`
      };
    }
  }

  if (listed.length >= 3) {
    return {
      verdict: 'proceed',
      icon: '✅',
      summary: 'Widely offered + RTPs aligned → Proceed to Phase 2'
    };
  }

  return {
    verdict: 'escalate',
    icon: '⚠️',
    summary: `Only ${listed.length}/${SITE_ORDER.length} competitors list this game → Escalate to Enhanced Due Diligence`
  };
}
