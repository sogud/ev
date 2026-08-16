import type React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './button';

interface ErrorMessageProps {
  error: string;
  onRetry?: () => void;
  className?: string;
}

/**
 * Reusable error notice component.
 */
const ErrorMessage: React.FC<ErrorMessageProps> = ({ error, onRetry, className = '' }) => {
  const { t } = useTranslation();
  return (
    <div className={`flex flex-col items-center justify-center p-8 text-center ${className}`}>
      <div className='mb-4 rounded-full bg-destructive/10 p-3'>
        <AlertCircle className='h-8 w-8 text-destructive' />
      </div>
      <h3 className='mb-2 text-lg font-semibold text-foreground'>
        {t('browser.newTab.errorTitle')}
      </h3>
      <p className='mb-4 max-w-md text-sm text-muted-foreground'>{error}</p>
      {onRetry && (
        <Button variant='outline' size='sm' onClick={onRetry} className='gap-2'>
          <RefreshCw className='h-4 w-4' />
          {t('browser.common.retry')}
        </Button>
      )}
    </div>
  );
};

export default ErrorMessage;
