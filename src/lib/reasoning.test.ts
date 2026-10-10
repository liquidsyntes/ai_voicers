import {describe,expect,it} from 'vitest';
import {suggestedReasoningEffort} from './reasoning';

describe('new cycle reasoning defaults',()=>{
  it('keeps reasoning on for the observed slow DeepSeek alias without changing other models',()=>{
    expect(suggestedReasoningEffort('~deepseek/deepseek-flash-latest')).toBe('low');
    expect(suggestedReasoningEffort('deepseek/deepseek-v4.1-flash')).toBe('low');
    expect(suggestedReasoningEffort('another/model')).toBe('auto');
  });
});
