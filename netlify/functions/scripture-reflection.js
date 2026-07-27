// Netlify Function: /.netlify/functions/scripture-reflection
//
// Pipeline:
//  1. Get today's actual Mass reading citations (e.g. "John 20:1-2, 11-18")
//     from the free, MIT-licensed, CORS-enabled Catholic Readings API
//     (https://github.com/cpbjr/catholic-readings-api), which is generated
//     from public liturgical-calendar rules rather than by scraping USCCB.
//  2. Look up the actual verse text for those citations from bible-api.com,
//     using the public-domain World English Bible translation.
//  3. Ask Claude to write a short, original reflection grounded in that
//     specific passage. Only the generated reflection + a bare citation
//     (not copyrighted) are ever returned to the client.
//
// Requires an ANTHROPIC_API_KEY environment variable set in Netlify's site
// settings (Site settings -> Environment variables).
//
// Note: an earlier version of this function scraped bible.usccb.org
// directly. USCCB's edge/WAF returns 403 to traffic from cloud/serverless
// IP ranges (this is a deliberate block, consistent with the copyright
// notice on their Lectionary text), so that approach was replaced with the
// citation-API + public-domain-text approach above, which avoids both the
// block and any copyright concern.

exports.handler = async function (event) {
  try {
    // Temporary self-diagnostic: reports which env var NAMES this function
    // instance can see (never values), to debug why ANTHROPIC_API_KEY isn't
    // being picked up. Remove once the key is confirmed working.
    if (event.queryStringParameters && event.queryStringParameters.debug === '1') {
      const allKeys = Object.keys(process.env).sort();
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hasAnthropicKeyExact: Object.prototype.hasOwnProperty.call(process.env, 'ANTHROPIC_API_KEY'),
          anthropicKeyLength: process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.length : 0,
          keysMatchingAnthropic: allKeys.filter((k) => /anthropic/i.test(k)).map((k) => JSON.stringify(k)),
          totalEnvKeyCount: allKeys.length,
          allNonNetlifyKeys: allKeys.filter((k) => !/^(NETLIFY|AWS|LAMBDA|LD_|PATH$|LANG$|_HANDLER|TZ$)/i.test(k)),
        }),
      };
    }

    const { year, monthDay, mmddyy } = resolveDate(event.queryStringParameters);

    const citations = await fetchCitations(year, monthDay);
    if (!citations.length) throw new Error('No citations available for ' + year + '-' + monthDay);

    const readings = await Promise.all(
      citations.map(async (c) => {
        const text = await fetchVerseText(c.citation).catch(() => null);
        return { label: c.label, citation: c.citation, body: text };
      })
    );
    const usable = readings.filter((r) => r.body);
    if (!usable.length) throw new Error('Could not retrieve text for any citation');

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

    const context = usable
      .map((r) => r.label + ' (' + r.citation + '):\n' + r.body.slice(0, 900))
      .join('\n\n');

    const prompt =
      "You are writing a short devotional reflection for a personal morning prayer app. " +
      "Below are today's Catholic Mass readings (citations and text, for your reference only " +
      "-- do not quote more than a short phrase back).\n\n" +
      context +
      '\n\n' +
      'Write a brief reflection, 2-3 sentences, in a warm, contemplative, non-preachy tone. ' +
      'Point to a specific, concrete detail or image from the passage(s) above (not generic ' +
      'spiritual advice), and end with a short, open invitation or question for the reader to ' +
      'sit with. Do not put quotation marks around scripture. Do not open with "Today\'s reading" ' +
      'or "In today\'s Gospel" -- vary the opening. Return only the reflection text, nothing else.';

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 220,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      throw new Error('Anthropic API error ' + aiRes.status + ': ' + errText.slice(0, 300));
    }
    const aiData = await aiRes.json();
    const reflection = ((aiData.content && aiData.content[0] && aiData.content[0].text) || '').trim();
    if (!reflection) throw new Error('Empty reflection from model');

    const primary = usable.find((r) => /gospel/i.test(r.label)) || usable[0];

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
      body: JSON.stringify({
        reflection: reflection,
        citation: primary.citation,
        label: primary.label,
        source: 'ai',
      }),
    };
  } catch (err) {
    // Fail soft: return 200 with an error field so the client can fall back
    // to its local static reflection pool without treating this as a hard
    // network failure.
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: String((err && err.message) || err), source: 'error' }),
    };
  }
};

function resolveDate(qs) {
  var dateParam = qs && qs.date; // expected "YYYY-MM-DD"
  var d;
  if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    var parts = dateParam.split('-');
    d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  } else {
    d = new Date();
  }
  var year = d.getUTCFullYear();
  var mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  var dd = String(d.getUTCDate()).padStart(2, '0');
  var yy = String(year).slice(-2);
  return { year: year, monthDay: mm + '-' + dd, mmddyy: mm + dd + yy };
}

async function fetchCitations(year, monthDay) {
  var url = 'https://cpbjr.github.io/catholic-readings-api/readings/' + year + '/' + monthDay + '.json';
  var res = await fetch(url);
  if (!res.ok) throw new Error('Readings API fetch failed: ' + res.status);
  var data = await res.json();
  var r = data.readings || {};
  var out = [];
  if (r.firstReading) out.push({ label: 'Reading 1', citation: r.firstReading });
  if (r.secondReading) out.push({ label: 'Reading 2', citation: r.secondReading });
  if (r.gospel) out.push({ label: 'Gospel', citation: r.gospel });
  return out;
}

async function fetchVerseText(citation) {
  // bible-api.com doesn't understand Lectionary-style verse-letter suffixes
  // (e.g. "4b") or "and" joiners -- strip those before querying.
  var cleaned = citation
    .replace(/(\d+)[a-z]\b/gi, '$1')
    .replace(/\band\b/gi, ',')
    .trim();
  var url = 'https://bible-api.com/' + encodeURIComponent(cleaned) + '?translation=web';
  var res = await fetch(url);
  if (!res.ok) throw new Error('bible-api.com fetch failed: ' + res.status);
  var data = await res.json();
  if (!data || !data.text) throw new Error('No verse text returned for ' + citation);
  return data.text.replace(/\s+/g, ' ').trim();
}
