import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CommandInfo, PromptImage, ThinkingLevel } from '../shared/types';

const ACCEPTED_IMAGE_TYPES = new Set<PromptImage['mimeType']>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;

interface DraftImage extends PromptImage {
  id: string;
  previewUrl: string;
}

async function readImage(file: File): Promise<DraftImage> {
  const previewUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image'));
    reader.readAsDataURL(file);
  });
  return {
    id: crypto.randomUUID(),
    type: 'image',
    data: previewUrl.slice(previewUrl.indexOf(',') + 1),
    mimeType: file.type as PromptImage['mimeType'],
    fileName: file.name,
    previewUrl,
  };
}

/** Codex parity: ⌘↑/⌘↓ steps thinking effort while the composer is focused. */
const EFFORT_ORDER: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function stepEffort(level: ThinkingLevel, delta: number): ThinkingLevel {
  const index = Math.max(0, EFFORT_ORDER.indexOf(level));
  const next = Math.min(EFFORT_ORDER.length - 1, Math.max(0, index + delta));
  return EFFORT_ORDER[next];
}

interface ComposerProps {
  running: boolean;
  disabled: boolean;
  imageInput?: boolean;
  queueInput?: boolean;
  /** Native slash commands / skills for the "/" menu (empty = no menu). */
  commands?: CommandInfo[];
  leading?: React.ReactNode;
  /** Present when the runtime supports thinking levels; enables ⌘↑/⌘↓ stepping. */
  effort?: { value: ThinkingLevel; onChange(value: ThinkingLevel): void };
  onSend(prompt: string, images?: PromptImage[], queue?: 'steer' | 'followUp'): void;
  onAbort(): void;
}

export function Composer({
  running,
  disabled,
  imageInput = false,
  queueInput = false,
  commands = [],
  leading,
  effort,
  onSend,
  onAbort,
}: ComposerProps): React.JSX.Element {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [images, setImages] = useState<DraftImage[]>([]);
  // Local sent-prompt history; ↑ on an empty input recalls previous prompts
  // (Codex-style), most recent first.
  const historyRef = useRef<string[]>([]);
  const recallIndexRef = useRef<number>(-1);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const slashMenuId = useId();

  const submit = (queue?: 'steer' | 'followUp'): void => {
    const prompt = value.trim() || (images.length > 0 ? t('composer.imagePrompt') : '');
    if (!prompt || disabled) return;
    historyRef.current.push(prompt);
    if (historyRef.current.length > 100) historyRef.current.shift();
    recallIndexRef.current = -1;
    setValue('');
    setSlashOpen(false);
    onSend(
      prompt,
      images.map(({ type, data, mimeType, fileName }) => ({ type, data, mimeType, fileName })),
      queue
    );
    setImages([]);
    if (ref.current) ref.current.style.height = 'auto';
  };

  const addFiles = async (files: File[]): Promise<void> => {
    const accepted = files
      .filter(
        file =>
          ACCEPTED_IMAGE_TYPES.has(file.type as PromptImage['mimeType']) &&
          file.size <= MAX_IMAGE_BYTES
      )
      .slice(0, Math.max(0, MAX_IMAGES - images.length));
    if (accepted.length === 0) return;
    const next = await Promise.all(accepted.map(readImage));
    setImages(current => [...current, ...next].slice(0, MAX_IMAGES));
  };

  const recall = (): void => {
    const history = historyRef.current;
    if (history.length === 0) return;
    const next =
      recallIndexRef.current < 0 ? history.length - 1 : Math.max(0, recallIndexRef.current - 1);
    recallIndexRef.current = next;
    setValue(history[next]);
  };

  const recallNext = (): void => {
    const history = historyRef.current;
    if (recallIndexRef.current < 0) return;
    const next = recallIndexRef.current + 1;
    if (next >= history.length) {
      recallIndexRef.current = -1;
      setValue('');
      return;
    }
    recallIndexRef.current = next;
    setValue(history[next]);
  };

  // Slash menu: active while the whole input is one "/command" query.
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashQuery = slashOpen && value.startsWith('/') ? value.slice(1).toLowerCase() : null;
  const slashMatches: CommandInfo[] =
    slashQuery === null
      ? []
      : commands
          .filter(command => command.name.toLowerCase().includes(slashQuery) || slashQuery === '')
          .slice(0, 8);

  const applyCommand = (name: string): void => {
    setValue(`/${name} `);
    setSlashOpen(false);
    ref.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashOpen && slashMatches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSlashIndex(index => (index + 1) % slashMatches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSlashIndex(index => (index - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        applyCommand(slashMatches[slashIndex]?.name ?? slashMatches[0].name);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSlashOpen(false);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.metaKey) {
      event.preventDefault();
      submit(event.altKey && running ? 'followUp' : undefined);
    } else if (event.metaKey && event.key === 'ArrowUp' && effort) {
      event.preventDefault();
      effort.onChange(stepEffort(effort.value, 1));
    } else if (event.metaKey && event.key === 'ArrowDown' && effort) {
      event.preventDefault();
      effort.onChange(stepEffort(effort.value, -1));
    } else if (event.key === 'ArrowUp' && value === '') {
      event.preventDefault();
      recall();
    } else if (event.key === 'ArrowDown' && recallIndexRef.current >= 0) {
      event.preventDefault();
      recallNext();
    }
  };

  return (
    <div className='composer-wrap'>
      {slashOpen && slashMatches.length > 0 && (
        <div
          id={slashMenuId}
          className='slash-menu'
          role='listbox'
          aria-label={t('composer.slashMenuAria')}>
          {slashMatches.map((command, index) => (
            <button
              type='button'
              role='option'
              tabIndex={-1}
              id={`${slashMenuId}-option-${index}`}
              aria-selected={index === slashIndex}
              className={index === slashIndex ? 'slash-item active' : 'slash-item'}
              key={command.name}
              onMouseEnter={() => setSlashIndex(index)}
              onClick={() => applyCommand(command.name)}>
              <span className='slash-name'>/{command.name}</span>
              {command.description && <span className='slash-desc'>{command.description}</span>}
            </button>
          ))}
        </div>
      )}
      <div className='composer'>
        {images.length > 0 && (
          <div className='composer-images'>
            {images.map(image => (
              <div className='composer-image' key={image.id}>
                <img src={image.previewUrl} alt={image.fileName ?? t('composer.imageAlt')} />
                <button
                  type='button'
                  aria-label={t('composer.removeImage')}
                  onClick={() =>
                    setImages(current => current.filter(item => item.id !== image.id))
                  }>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          value={value}
          rows={1}
          placeholder={t('composer.placeholder')}
          role='combobox'
          aria-autocomplete='list'
          aria-haspopup='listbox'
          aria-expanded={slashOpen && slashMatches.length > 0}
          aria-controls={slashOpen && slashMatches.length > 0 ? slashMenuId : undefined}
          aria-activedescendant={
            slashOpen && slashMatches.length > 0 ? `${slashMenuId}-option-${slashIndex}` : undefined
          }
          aria-label={t('composer.inputAria')}
          disabled={disabled}
          onChange={event => {
            recallIndexRef.current = -1;
            setValue(event.target.value);
            setSlashOpen(event.target.value.startsWith('/'));
            setSlashIndex(0);
            event.target.style.height = 'auto';
            event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
          }}
          onKeyDown={handleKeyDown}
          onPaste={event => {
            if (!imageInput) return;
            const files = [...event.clipboardData.files].filter(file =>
              file.type.startsWith('image/')
            );
            if (files.length === 0) return;
            event.preventDefault();
            void addFiles(files);
          }}
        />
        <div className='composer-actions'>
          {imageInput && (
            <>
              <input
                ref={fileRef}
                className='composer-file-input'
                type='file'
                accept='image/png,image/jpeg,image/gif,image/webp'
                multiple
                onChange={event => {
                  void addFiles([...(event.target.files ?? [])]);
                  event.target.value = '';
                }}
              />
              <button
                className='composer-attach'
                type='button'
                aria-label={t('composer.attachImage')}
                title={t('composer.attachImage')}
                disabled={disabled || images.length >= MAX_IMAGES}
                onClick={() => fileRef.current?.click()}>
                <Paperclip size={15} />
              </button>
            </>
          )}
          {leading}
          <span className='composer-hint'>
            {running ? (queueInput ? t('composer.hintRunning') : '') : t('composer.hint')}
          </span>
          {running && queueInput ? (
            <>
              <button
                className='send-button stop'
                type='button'
                aria-label={t('composer.stopAria')}
                title={t('composer.stopAria')}
                onClick={onAbort}>
                <Square size={13} fill='currentColor' />
              </button>
              <button
                className='send-button'
                type='button'
                aria-label={t('composer.queueSendAria')}
                title={t('composer.queueSendTitle')}
                disabled={(!value.trim() && images.length === 0) || disabled}
                onClick={() => submit()}>
                <ArrowUp size={17} />
              </button>
            </>
          ) : running ? (
            <button
              className='send-button stop'
              type='button'
              aria-label={t('composer.stopAria')}
              title={t('composer.stopAria')}
              onClick={onAbort}>
              <Square size={13} fill='currentColor' />
            </button>
          ) : (
            <button
              className='send-button'
              type='button'
              aria-label={t('common.send')}
              disabled={(!value.trim() && images.length === 0) || disabled}
              onClick={() => submit()}>
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
