import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const buttonVariants = cva('ev-button whitespace-nowrap', {
  variants: {
    variant: {
      default: 'ev-button-primary',
      destructive: 'ev-button-destructive',
      outline: 'ev-button-outline',
      secondary: 'ev-button-secondary',
      ghost: 'ev-button-ghost',
      link: 'text-[var(--ev-color-text-link)] underline-offset-4 hover:underline',
    },
    size: {
      default: '',
      sm: 'ev-button-sm',
      lg: 'ev-button-lg',
      icon: 'ev-button-icon',
    },
  },
  defaultVariants: {
    variant: 'default',
    size: 'default',
  },
});

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  )
);
Button.displayName = 'Button';

export { Button, buttonVariants };
