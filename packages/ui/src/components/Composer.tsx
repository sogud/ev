import { ArrowUp, Square } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ComposerProps {
  running: boolean;
  disabled: boolean;
  leading?: React.ReactNode;
  onSend(prompt: string): void;
  onAbort(): void;
}

export function Composer({
  running,
  disabled,
  leading,
  onSend,
  onAbort,
}: ComposerProps): React.JSX.Element {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const submit = (): void => {
    const prompt = value.trim();
    if (!prompt || disabled) return;
    setValue('');
    onSend(prompt);
    if (ref.current) ref.current.style.height = 'auto';
  };

  return (
    <div className='composer-wrap'>
      <div className='composer'>
        <textarea
          ref={ref}
          value={value}
          rows={1}
          placeholder={t('composer.placeholder')}
          aria-label={t('composer.inputAria')}
          disabled={disabled}
          onChange={event => {
            setValue(event.target.value);
            event.target.style.height = 'auto';
            event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className='composer-actions'>
          {leading}
          <span className='composer-hint'>{t('composer.hint')}</span>
          {running ? (
            <button
              className='send-button stop'
              type='button'
              aria-label={t('composer.stopAria')}
              onClick={onAbort}>
              <Square size={13} fill='currentColor' />
            </button>
          ) : (
            <button
              className='send-button'
              type='button'
              aria-label={t('common.send')}
              disabled={!value.trim() || disabled}
              onClick={submit}>
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
