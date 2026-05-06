import { Suspense } from "react";
import { AuthForm } from "@/components/AuthForm";

// useSearchParams() requires a Suspense boundary at build time.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <AuthForm mode="login" />
    </Suspense>
  );
}
