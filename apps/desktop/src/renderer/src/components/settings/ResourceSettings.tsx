import { useTranslation } from 'react-i18next';
import { Box, LoaderCircle, Puzzle, Save, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ResourceSnapshot } from '../../../../shared/types';

function lines(value: string): string[] {
  return value
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean);
}

export function ResourceSettings(): React.JSX.Element {
  const { t } = useTranslation();
  const [resources, setResources] = useState<ResourceSnapshot | null>(null);
  const [packages, setPackages] = useState('');
  const [skills, setSkills] = useState('');
  const [extensions, setExtensions] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const apply = (value: ResourceSnapshot): void => {
    setResources(value);
    setPackages(value.packages.join('\n'));
    setSkills(value.skillPaths.join('\n'));
    setExtensions(value.extensionPaths.join('\n'));
  };

  useEffect(() => {
    void window.agentDesktop.resources
      .get()
      .then(apply)
      .catch(reason => setError(String(reason)));
  }, []);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError('');
    try {
      apply(
        await window.agentDesktop.resources.update({
          packages: lines(packages),
          skillPaths: lines(skills),
          extensionPaths: lines(extensions),
        })
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  if (!resources)
    return (
      <div className='settings-loading'>
        <LoaderCircle className='spin' size={18} />
        {t('resources.loading')}
        {error && <p>{error}</p>}
      </div>
    );

  return (
    <div className='resource-settings settings-scroll'>
      <div className='settings-page-heading'>
        <h2>{t('resources.title')}</h2>
        <p>{t('resources.desc')}</p>
      </div>
      <section className='resource-editor-grid'>
        <label>
          <Box size={16} />
          <span>
            <strong>Packages</strong>
            <small>{t('resources.packagesDesc')}</small>
          </span>
          <textarea rows={5} value={packages} onChange={event => setPackages(event.target.value)} />
        </label>
        <label>
          <Sparkles size={16} />
          <span>
            <strong>{t('resources.skillsLabel')}</strong>
            <small>{t('resources.skillsDesc')}</small>
          </span>
          <textarea rows={5} value={skills} onChange={event => setSkills(event.target.value)} />
        </label>
        <label>
          <Puzzle size={16} />
          <span>
            <strong>{t('resources.extensionsLabel')}</strong>
            <small>{t('resources.extensionsDesc')}</small>
          </span>
          <textarea
            rows={5}
            value={extensions}
            onChange={event => setExtensions(event.target.value)}
          />
        </label>
      </section>

      <button
        className='primary-button compact'
        type='button'
        disabled={saving}
        onClick={() => void save()}>
        {saving ? <LoaderCircle className='spin' size={15} /> : <Save size={15} />}{' '}
        {t('resources.save')}
      </button>
      {error && <p className='inline-error'>{error}</p>}

      <section className='discovered-resources'>
        <h3>
          {t('resources.loadedSkills')} <span>{resources.skills.length}</span>
        </h3>
        <div className='resource-list'>
          {resources.skills.map(item => (
            <div key={item.path}>
              <Sparkles size={15} />
              <span>
                <strong>{item.name}</strong>
                <small>{item.description || item.path}</small>
              </span>
              <code>{item.source}</code>
            </div>
          ))}
        </div>
        <h3>
          {t('resources.loadedExtensions')} <span>{resources.extensions.length}</span>
        </h3>
        <div className='resource-list'>
          {resources.extensions.map(item => (
            <div key={item.path}>
              <Puzzle size={15} />
              <span>
                <strong>{item.name}</strong>
                <small>{item.path}</small>
              </span>
              <code>{item.source}</code>
            </div>
          ))}
        </div>
        {resources.diagnostics.length > 0 && (
          <details className='diagnostics'>
            <summary>{t('resources.diagnostics', { count: resources.diagnostics.length })}</summary>
            {resources.diagnostics.map(item => (
              <p key={item}>{item}</p>
            ))}
          </details>
        )}
      </section>
    </div>
  );
}
