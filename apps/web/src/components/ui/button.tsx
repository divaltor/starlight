import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type * as React from "react";
import type { Ref } from "react";
import { mergeProps, useObjectRef } from "react-aria";
import { useButton } from "react-aria/useButton";

import { cn } from "@/lib/utils";

const buttonVariants = cva("btn transition-all duration-150 ease-in-out", {
  variants: {
    variant: {
      default: "btn-primary",
      destructive: "btn-error",
      outline: "btn-outline",
      secondary: "btn-secondary",
      ghost: "btn-ghost",
      link: "btn-link",
      accent: "btn-accent",
      neutral: "btn-neutral",
      active: "btn-active",
    },
    size: {
      default: "btn-md",
      sm: "btn-sm",
      lg: "btn-lg",
      xs: "btn-xs",
      xl: "btn-xl",
      icon: "btn-circle size-9",
    },
    pressed: {
      true: "btn-active",
    },
    isSoft: {
      true: "btn-soft",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
  },
});

function Button({
  className,
  variant,
  size,
  isSoft,
  ref,
  children,
  type = "button",
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    ref?: Ref<HTMLButtonElement>;
  }) {
  const buttonRef = useObjectRef(ref);

  const { buttonProps, isPressed } = useButton({ isDisabled: props.disabled }, buttonRef);

  const classes = cn(
    buttonVariants({
      variant,
      size,
      pressed: isPressed,
      isSoft,
      className,
    }),
    isPressed ? "scale-98" : "scale-100",
  );

  return (
    <button
      {...mergeProps(buttonProps, props)}
      className={classes}
      data-pressed={isPressed || undefined}
      ref={buttonRef}
      type="button"
      // Consumers may override the default type (e.g. type="submit" in forms).
      {...(type === "button" ? {} : { type })}
    >
      {children}
    </button>
  );
}

Button.displayName = "Button";

export { Button, buttonVariants };
