import { sanitizeInput } from '../../src/utils/sanitizer';

describe('sanitizeInput', () => {
  describe('normal, safe text', () => {
    it('passes through plain text unchanged', () => {
      const input = 'Hello World';
      expect(sanitizeInput(input)).toBe('Hello World');
    });

    it('passes through alphanumeric text unchanged', () => {
      const input = 'scout123player456';
      expect(sanitizeInput(input)).toBe('scout123player456');
    });

    it('passes through text with common punctuation', () => {
      const input = 'Player name: John. Age: 25!';
      expect(sanitizeInput(input)).toBe('Player name: John. Age: 25!');
    });

    it('passes through text with hyphens and underscores', () => {
      const input = 'user_name-with-dashes';
      expect(sanitizeInput(input)).toBe('user_name-with-dashes');
    });

    it('passes through text with parentheses and brackets', () => {
      const input = 'Player (GK) [West Africa]';
      expect(sanitizeInput(input)).toBe('Player (GK) [West Africa]');
    });
  });

  describe('HTML and script-tag content (XSS prevention)', () => {
    it('encodes HTML tags', () => {
      const input = '<div>Hello</div>';
      expect(sanitizeInput(input)).toBe('&lt;div&gt;Hello&lt;/div&gt;');
    });

    it('encodes script tags', () => {
      const input = '<script>alert("xss")</script>';
      expect(sanitizeInput(input)).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });

    it('encodes iframe tags', () => {
      const input = '<iframe src="evil.com"></iframe>';
      expect(sanitizeInput(input)).toBe('&lt;iframe src=&quot;evil.com&quot;&gt;&lt;/iframe&gt;');
    });

    it('encodes img tags with event handlers', () => {
      const input = '<img src="x" onerror="alert(1)">';
      expect(sanitizeInput(input)).toBe('&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;');
    });

    it('encodes on* event attributes', () => {
      const input = 'onclick="bad()" onload="worse()"';
      expect(sanitizeInput(input)).toBe('onclick=&quot;bad()&quot; onload=&quot;worse()&quot;');
    });

    it('encodes style tags', () => {
      const input = '<style>body { color: red; }</style>';
      expect(sanitizeInput(input)).toBe('&lt;style&gt;body { color: red; }&lt;/style&gt;');
    });
  });

  describe('SQL metacharacters', () => {
    it('HTML-escapes single quotes (still HTML-encoded for XSS safety)', () => {
      const input = "It's a player's profile";
      expect(sanitizeInput(input)).toBe("It&#x27;s a player&#x27;s profile");
    });

    it('HTML-escapes double quotes (still HTML-encoded for XSS safety)', () => {
      const input = 'Player said "I am the best"';
      expect(sanitizeInput(input)).toBe('Player said &quot;I am the best&quot;');
    });

    it('passes through non-quote SQL metacharacters while escaping quotes', () => {
      const input = "SELECT * FROM players WHERE id = '123';";
      expect(sanitizeInput(input)).toBe("SELECT * FROM players WHERE id = &#x27;123&#x27;;");
    });

    it('passes through semicolons', () => {
      const input = 'Goal 1; Goal 2; Goal 3';
      expect(sanitizeInput(input)).toBe('Goal 1; Goal 2; Goal 3');
    });

    it('passes through SQL-like comment syntax', () => {
      const input = '-- This is a note -- about the player';
      expect(sanitizeInput(input)).toBe('-- This is a note -- about the player');
    });
  });

  describe('control characters and special cases', () => {
    it('trims leading whitespace', () => {
      const input = '   Hello World';
      expect(sanitizeInput(input)).toBe('Hello World');
    });

    it('trims trailing whitespace', () => {
      const input = 'Hello World   ';
      expect(sanitizeInput(input)).toBe('Hello World');
    });

    it('trims both leading and trailing whitespace', () => {
      const input = '   Hello World   ';
      expect(sanitizeInput(input)).toBe('Hello World');
    });

    it('preserves internal spaces', () => {
      const input = 'Hello   World';
      expect(sanitizeInput(input)).toBe('Hello   World');
    });

    it('removes null characters (charCode 0)', () => {
      const input = 'Hello\x00World';
      expect(sanitizeInput(input)).toBe('HelloWorld');
    });

    it('removes tab characters (charCode 9)', () => {
      const input = 'Hello\tWorld';
      expect(sanitizeInput(input)).toBe('HelloWorld');
    });

    it('removes newline characters (charCode 10)', () => {
      const input = 'Hello\nWorld';
      expect(sanitizeInput(input)).toBe('HelloWorld');
    });

    it('removes carriage return characters (charCode 13)', () => {
      const input = 'Hello\rWorld';
      expect(sanitizeInput(input)).toBe('HelloWorld');
    });

    it('removes DEL character (charCode 127)', () => {
      const input = 'Hello\x7fWorld';
      expect(sanitizeInput(input)).toBe('HelloWorld');
    });

    it('removes all control characters from 0-31', () => {
      let input = 'Test';
      for (let i = 0; i <= 31; i++) {
        input = `Before${String.fromCharCode(i)}After`;
        const result = sanitizeInput(input);
        expect(result).toBe('BeforeAfter');
      }
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(sanitizeInput('')).toBe('');
    });

    it('handles whitespace-only string', () => {
      const input = '   \t\n  ';
      expect(sanitizeInput(input)).toBe('');
    });

    it('handles very long string', () => {
      const input = 'A'.repeat(10000);
      expect(sanitizeInput(input)).toBe('A'.repeat(10000));
    });

    it('handles very long string with control characters', () => {
      const input = 'A\x00'.repeat(1000); // 2000 chars, every other is null
      const result = sanitizeInput(input);
      expect(result).toBe('A'.repeat(1000));
    });
  });

  describe('Unicode and non-ASCII input', () => {
    it('preserves Latin extended characters', () => {
      const input = 'Café, naïve, résumé';
      expect(sanitizeInput(input)).toBe('Café, naïve, résumé');
    });

    it('preserves Greek characters', () => {
      const input = 'Αλέξανδρος';
      expect(sanitizeInput(input)).toBe('Αλέξανδρος');
    });

    it('preserves Cyrillic characters', () => {
      const input = 'Александр';
      expect(sanitizeInput(input)).toBe('Александр');
    });

    it('preserves Arabic characters', () => {
      const input = 'علي';
      expect(sanitizeInput(input)).toBe('علي');
    });

    it('preserves Chinese characters', () => {
      const input = '王小明';
      expect(sanitizeInput(input)).toBe('王小明');
    });

    it('preserves Japanese characters', () => {
      const input = '田中太郎';
      expect(sanitizeInput(input)).toBe('田中太郎');
    });

    it('preserves emoji characters', () => {
      const input = '⚽🎯💪';
      expect(sanitizeInput(input)).toBe('⚽🎯💪');
    });

    it('preserves mixed Unicode and ASCII', () => {
      const input = 'Player: João (23) 🇧🇷';
      expect(sanitizeInput(input)).toBe('Player: João (23) 🇧🇷');
    });
  });

  describe('non-string inputs', () => {
    it('returns non-string input unchanged (number)', () => {
      const input = 123 as unknown as string;
      expect(sanitizeInput(input)).toBe(123);
    });

    it('returns non-string input unchanged (boolean)', () => {
      const input = true as unknown as string;
      expect(sanitizeInput(input)).toBe(true);
    });

    it('returns non-string input unchanged (null)', () => {
      const input = null as unknown as string;
      expect(sanitizeInput(input)).toBe(null);
    });

    it('returns non-string input unchanged (object)', () => {
      const input = { foo: 'bar' } as unknown as string;
      expect(sanitizeInput(input)).toBe(input);
    });

    it('returns non-string input unchanged (undefined)', () => {
      const input = undefined as unknown as string;
      expect(sanitizeInput(input)).toBe(undefined);
    });

    it('returns non-string input unchanged (array)', () => {
      const input = ['a', 'b'] as unknown as string;
      expect(sanitizeInput(input)).toBe(input);
    });
  });

  describe('combined scenarios', () => {
    it('handles mixed control characters and valid text', () => {
      const input = 'Hello\x00World\nTest\tString';
      expect(sanitizeInput(input)).toBe('HelloWorldTestString');
    });

    it('handles HTML with control characters', () => {
      const input = '<script>\x00alert("xss")\n</script>';
      expect(sanitizeInput(input)).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    });

    it('handles whitespace, control chars, and Unicode', () => {
      const input = '  \nJoão\x00Silva\t🇧🇷  ';
      expect(sanitizeInput(input)).toBe('JoãoSilva🇧🇷');
    });

    it('handles SQL injection attempt with control chars', () => {
      const input = "'; DROP TABLE players; --\x00\n";
      expect(sanitizeInput(input)).toBe("&#x27;; DROP TABLE players; --");
    });
  });
});

import { sanitizeObject } from '../../src/utils/sanitizer';

describe('sanitizeObject', () => {
  it('sanitizes strings in objects', () => {
    const input = { name: '<script>alert(1)</script>', age: 25 };
    expect(sanitizeObject(input)).toEqual({ name: '&lt;script&gt;alert(1)&lt;/script&gt;', age: 25 });
  });

  it('sanitizes strings in nested objects', () => {
    const input = { user: { profile: { bio: 'hello\nworld' } } };
    expect(sanitizeObject(input)).toEqual({ user: { profile: { bio: 'helloworld' } } });
  });

  it('sanitizes strings in arrays', () => {
    const input = ['<a href="javascript:alert(1)">', 42];
    expect(sanitizeObject(input)).toEqual(['&lt;a href=&quot;javascript:alert(1)&quot;&gt;', 42]);
  });
});
