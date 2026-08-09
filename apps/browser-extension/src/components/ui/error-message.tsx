import React from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
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
  return (
    <div className={`flex flex-col items-center justify-center p-8 text-center ${className}`}>
      <div className='mb-4 rounded-full bg-destructive/10 p-3'>
        <AlertCircle className='h-8 w-8 text-destructive' />
      </div>
      <h3 className='mb-2 text-lg font-semibold text-foreground'>Something went wrong</h3>
      <p className='mb-4 max-w-md text-sm text-muted-foreground'>{error}</p>
      {onRetry && (
        <Button variant='outline' size='sm' onClick={onRetry} className='gap-2'>
          <RefreshCw className='h-4 w-4' />
          Retry
        </Button>
      )}
    </div>
  );
};

export default ErrorMessage;
