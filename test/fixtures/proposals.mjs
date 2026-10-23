export const proposals = [
  ['The body $M$ is type checked as follows. This judgment combines the operation types with the surrounding context.',
    'The body $M$ is typed as follows. This judgment combines the operation types with the surrounding context.'],
  ['\u5f53 $x_1$ \u5927\u4e8e\u96f6\u65f6\uff0c**\u8fd9\u4e2a\u5224\u65ad**\u6210\u7acb\u3002\n\n\\[x_1 > 0\\]',
    '\u5f53 $x_2$ \u4e3a\u6b63\u6570\u65f6\uff0c**\u8be5\u5224\u65ad**\u6210\u7acb\u3002\n\n\\[x_2 > 0\\]'],
];
export const proposalReply = proposals.map(([before, after]) => `:::proposal\n[before]\n${before}\n[after]\n${after}\n:::`).join('\n\n');
